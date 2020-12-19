module.exports = function (RED) {
  'use strict';
  const stompit = require('stompit');
  const { pipeline: originalPipeline, Writable } = require('stream');
  const { promisify } = require('util');
  const pipeline = promisify(originalPipeline);

  // Stomp Server Node
  //
  function StompServerNode(n) {
    RED.nodes.createNode(this, n);
    this.server = n.server;
    this.port = n.port;
    this.vhost = n.vhost || '/';
    this.heartbeat = n.heartbeat;
    this.name = n.name;
    this.username = this.credentials.user;
    this.password = this.credentials.password;
  }
  RED.nodes.registerType('emu-stomp-server', StompServerNode, {
    credentials: {
      user: { type: 'text' },
      password: { type: 'password' },
    },
  });

  // Stomp IN Node
  //
  function StompInNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    const topic = n.topic;
    const encoding = n.encoding;
    const serverConfig = RED.nodes.getNode(n.server);

    connectClient(this, serverConfig, (client) => {
      const subscribeHeaders = {
        destination: topic,
        ack: 'client-individual',
      };

      // Subscribe to topic
      client.subscribe(subscribeHeaders, (error, message) => {
        if (error) {
          node.status({ fill: 'red', shape: 'dot', text: 'error' });
          node.warn(error);
          return;
        }

        // Create chunkCollector writeable to collect chunks
        const chunks = [];
        const chunkCollector = new Writable({
          write(chunk, encoding, cb) {
            chunks.push(chunk);
            cb();
          },
        });

        // Create msg processing pipeline
        const msgPipeline = pipeline(message, chunkCollector);

        // Start pipeline to process message stream and collect chunks
        msgPipeline
          .then(() => {
            // Success - concat msg content and send onwards
            let msgContent = Buffer.concat(chunks);

            switch (encoding) {
              case 'string':
                msgContent = msgContent.toString('utf8');
                break;

              case 'json':
                try {
                  msgContent = JSON.parse(msgContent.toString('utf8'));
                } catch (e) {
                  node.warn('Non-JSON data received');
                }
                break;
              default:
                // buffer
                break;
            }

            node.send({ topic, headers: message.headers, payload: msgContent });
            client.ack(message);
          })
          .catch((error) => {
            // Pipeline failed
            node.status({ fill: 'red', shape: 'dot', text: 'error' });
            node.warn(error);
            client.ack(message);
          });
      });

      // Disconnect client on node close
      node.on('close', function () {
        node.log('Disconnecting STOMP client');
        client.disconnect();
      });
    });
  }
  RED.nodes.registerType('emu-stomp-in', StompInNode);

  // Stomp OUT Node
  //
  function StompOutNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    const topic = n.topic;
    const encoding = n.encoging;
    const serverConfig = RED.nodes.getNode(n.server);
    const contentType = encoding === 'json' ? 'application/json' : 'text/plain';

    connectClient(this, serverConfig, (client) => {
      // Attach input handler after client has connected
      node.on('input', function (msg, send, done) {
        let payload = msg.payload;

        if (typeof payload !== 'string') {
          payload = JSON.stringify(payload);
        }

        const sendHeaders = {
          ...msg.headers,
          destination: topic || msg.topic,
          'content-length': payload.length,
        };

        const frame = client.send(sendHeaders, {
          onError: function (error) {
            node.status({ fill: 'red', shape: 'dot', text: 'error' });
            node.warn(error);
          },
        });

        frame.write(payload);
        frame.end();

        done && done();
      });

      // Disconnect client on node close
      node.on('close', function (done) {
        node.log('Disconnecting STOMP client');
        client.disconnect();
        done();
      });
    });
  }
  RED.nodes.registerType('emu-stomp-out', StompOutNode);

  /**
   * Connect StompIt client to server
   *
   * @param {*} node Node-Red node
   * @param {*} serverConfig Server configuration node
   * @param {*} connectCallback Callback on successful connect
   */
  function connectClient(node, serverConfig, connectCallback) {
    const connectOptions = {
      host: serverConfig.server,
      port: +serverConfig.port,
      connectHeaders: {
        host: serverConfig.vhost,
        login: serverConfig.username,
        passcode: serverConfig.password,
        'heart-beat': serverConfig.heartbeat,
      },
    };

    return stompit.connect(connectOptions, (error, client) => {
      if (error) {
        node.status({ fill: 'red', shape: 'dot', text: 'error' });
        node.warn(error);
      } else {
        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        node.log('Stomp client connected');

        connectCallback(client);
      }
    });
  }
};
