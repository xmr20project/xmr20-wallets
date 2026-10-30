// The Monero nodes this extension may read from. The list is fixed at
// build time: it must match the worker allowlist, the manifest host permissions
// and the popup connect-src policy, so pages and preferences can only choose
// among these, never add one.
export const MONERO_NODES=[
 {url:'https://api.xmr20.org/monero',label:'XMR20 node'},
 {url:'https://xmr-node.cakewallet.com:18081',label:'Cake Wallet'},
 {url:'https://node.sethforprivacy.com',label:'Seth for Privacy'}
];
export const DEFAULT_MONERO_NODE=MONERO_NODES[0].url;
export function normalizeMoneroNode(value){return MONERO_NODES.some(n=>n.url===value)?value:DEFAULT_MONERO_NODE;}
// Saved scan metadata records where a pass succeeded, not a durable override
// of the user's node setting or the current default.
export function preferredMoneroNode(preferences){return normalizeMoneroNode(preferences?.moneroNode);}
export function moneroNodeLabel(url){return MONERO_NODES.find(n=>n.url===url)?.label||'Monero node';}
export function moneroNodeHost(url){try{return new URL(url).host;}catch{return String(url||'');}}
// Human progress for a scan: percentage, blocks left and a rough time estimate
// from the rate observed since the scan began.
export function scanProgress({height,target,start,startedAt,now=Date.now()}){
 if(!Number.isSafeInteger(height)||!Number.isSafeInteger(target)||target<=0)return null;
 // Below the start the wallet is still fetching the block-hash list, not scanning blocks.
 const from=Number.isSafeInteger(start)?start:height;
 const total=Math.max(target-from,0),done=Math.max(Math.min(height-from,total),0),left=Math.max(target-Math.max(height,from),0);
 const percent=total===0?100:Math.min(100,Math.floor(done*100/total));
 let eta=null;
 if(Number.isSafeInteger(startedAt)&&done>0){const seconds=(now-startedAt)/1000;if(seconds>=2){const rate=done/seconds;if(rate>0)eta=Math.ceil(left/rate);}}
 return {percent,left,done,total,eta};
}
export function scanEtaLabel(seconds){
 if(!Number.isFinite(seconds)||seconds<0)return '';
 if(seconds<60)return 'under a minute';
 const minutes=Math.ceil(seconds/60);if(minutes<60)return 'about '+minutes+' min';
 const hours=Math.floor(minutes/60),rest=minutes%60;return 'about '+hours+' h'+(rest?' '+rest+' min':'');
}
