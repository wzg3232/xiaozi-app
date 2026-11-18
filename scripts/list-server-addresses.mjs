import {networkInterfaces} from 'node:os';
console.log('Phone server address (same local network):');
for(const entries of Object.values(networkInterfaces()))for(const address of entries||[])if(address.family==='IPv4'&&!address.internal)console.log(`  http://${address.address}:${process.env.PORT||4200}`);
