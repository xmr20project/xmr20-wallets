// MONERO MARKET (30 Oct 2026, stagenet): opens the token worker for the market window, the background runner and the website
// wallet. A node can reset a reused connection while the worker opens ("Failed to fetch" on the local stagenet node), and a
// failed open leaves that worker unusable ("Already open"), so a fresh worker is tried a few times before giving up.
export const NETWORK_ERROR=/Failed to fetch|NetworkError|ERR_CONNECTION|Load failed/i;
// spawn() -> {client, retire}: retire() closes a worker that will not be used, without reporting it as a dead wallet.
export async function openTokenWorker({spawn,open,attempts=4,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 for(let attempt=1;;attempt++){
  const worker=spawn();
  try{return {client:worker.client,opened:await open(worker.client)};}
  catch(e){worker.retire();if(attempt>=attempts||!NETWORK_ERROR.test(String(e?.message||e)))throw e;await pause(1500*attempt);}
 }
}
