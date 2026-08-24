import { getRuntime } from '../src/runtime/runtime.js';
import { request } from '../src/core/message.js';

async function run() {
  const runtime = getRuntime();
  const bus = runtime.bus;

  // 1. Find PeerRegistry
  const peerRegistryId = bus.findByName('PeerRegistry');
  console.log('PeerRegistry ID:', peerRegistryId);

  if (peerRegistryId) {
    // List network peers
    const networkPeers = await bus.request(request('lab', peerRegistryId, 'listNetworkPeers', {}));
    console.log('Network Peers:', networkPeers);

    // If any peer starts with fec6df964f16 or exists, promote to contact
    if (Array.isArray(networkPeers) && networkPeers.length > 0) {
      for (const peer of networkPeers) {
        console.log('Promoting peer to contact:', peer.peerId);
        const res = await bus.request(request('lab', peerRegistryId, 'promoteToContact', { peerId: peer.peerId, name: 'Remote Peer (fec6df)' }));
        console.log('Promote result:', res);
      }
    }
  }

  // 2. Find Chat object or ChatManager
  const chatId = bus.findByName('Chat') ?? bus.findByType('Chat');
  console.log('Chat ID:', chatId);

  if (chatId) {
    console.log('Sending "Hello world from Antigravity & Gemini 3.6 Flash!" to Chat...');
    const chatRes = await bus.request(request('lab', chatId, 'sendMessage', { message: 'Hello world from Antigravity & Gemini 3.6 Flash!' }), 15000);
    console.log('Chat response:', chatRes);
  } else {
    console.log('No Chat instance found active in bus.');
  }
}

run().catch(console.error);
