import {createPrivateMarketClient} from '../../engine/shared/website/native-market-private-client.js';
import {moneroWalletIdentity} from '../../engine/shared/native-market/wallet/identity.mjs';
import {summarizeNativeHoldings,saveNativeHoldings,nativeTokenMetadata} from '../../engine/shared/native-token-holdings.js';
import {createCompanionScan} from './shared-wallet-scan.js';

// This module runs only in packaged wallet pages, never in the website. It reads
// the existing extension vault via its bound internal approval channel.
export function createExtensionMarketHost({requestId, syncBalance, runtime = chrome.runtime,
  storage = chrome.storage, workerFactory = () => new Worker(runtime.getURL('market/native-wallet/worker.js')),
  clientFactory = createPrivateMarketClient} = {}) {
  if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw Error('Open the market from the connected website.');
  const progressListeners=new Set();let showBalanceProgress=false,balanceRound=false;
  const companion=createCompanionScan(syncBalance,value=>{if(showBalanceProgress)for(const listener of progressListeners)listener(value);});
  let closed=false,released=false,account=null,sessionId=null,client=null;
  const current=()=>{if(closed||!account)throw Error('Market wallet changed or locked. Reconnect from the website.');};
  async function call(action,args={}){
    if(closed)throw Error('Wallet market is closed.');
    const response=await runtime.sendMessage({channel:'xmr20-site-approval',requestId,action,...args});
    if(closed||response?.error||!response||!Object.hasOwn(response,'value')){close();throw Error('Market wallet changed or locked. Reconnect from the website.');}
    return response.value;
  }
  const changed=(changes,area)=>{
    if(area==='local'&&(changes['xmr20-lock-signal']||changes['xmr20-vault']))close();
    if(area==='session'&&changes['xmr20-unlocked-session']){
      const s=changes['xmr20-unlocked-session'].newValue;
      if(!s||s.id!==sessionId||s.activeId!==account?.id)close();
    }
    if(area==='session'&&changes['xmr20-site-connection']&&!changes['xmr20-site-connection'].newValue?.markets?.[requestId])close();
  };
  function close(){if(closed)return;closed=true;companion.close();client?.dispose();progressListeners.clear();storage.onChanged.removeListener(changed);account=null;}
  async function check(){
    current();const result=await call('marketCheck');current();
    if(result.sessionId!==sessionId||result.account.id!==account.id||result.account.monero!==account.monero||result.account.solana!==account.solana){close();throw Error('Wallet account changed.');}
  }
  return Object.freeze({
    async open(){
      if(account||closed)throw Error('Market wallet already opened or closed.');
      const value=await call('marketView');account=Object.freeze({...value.account});sessionId=value.sessionId;
      storage.onChanged.addListener(changed);await check();
      const pinned=account;
      const provider={getMoneroAddress:()=>pinned.monero,assertCurrent:current,checkCurrent:check};
      const privateClient=clientFactory({onProgress:value=>{if(!closed)for(const listener of progressListeners)listener(value);},context:{owner:moneroWalletIdentity(pinned.monero),network:'mainnet',address:pinned.monero,restoreHeight:value.restoreHeight??0},provider,assertCurrent:current,workerFactory,
        vault:{async load(){await check();const keys=await call('marketKeys');try{await check();if(keys.address!==pinned.monero)throw Error('Monero account changed.');return keys.seed;}finally{keys.seed='';}}}});
      let checkpoint=null;
      client=Object.freeze({...privateClient,
        subscribeProgress(listener){progressListeners.add(listener);return ()=>progressListeners.delete(listener);},
        async feeFundingStatus(){
          const result=await privateClient.feeFundingStatus();current();
          const balance=companion.snapshot;
          return {...result,...(balance?.address===pinned.monero?{nativeBalance:{balanceRaw:balance.balanceRaw,unlockedRaw:balance.unlockedRaw,height:balance.height}}:{})};
        },
        async sync(){
          checkpoint=null;if(!balanceRound){companion.start();balanceRound=true;}
          try{
            let result=await privateClient.sync();current();
            if(result.ready){
              // The ordinary balance scan can take minutes after token history
              // reaches its tip. Refresh that tip after the wait so the next
              // funding check does not use an expired signing checkpoint.
              const waited=typeof syncBalance==='function'&&!companion.finished;
              showBalanceProgress=true;
              try{await companion.finish();current();}finally{showBalanceProgress=false;balanceRound=false;}
              if(waited){result=await privateClient.sync();current();}
              if(result.ready)checkpoint=result;
            }
            return result;
          }
          catch(error){balanceRound=false;throw error;}
        },
        async inventory(){
          const rows=await privateClient.inventory();current();
          if(checkpoint&&nativeTokenMetadata()){
            const value=summarizeNativeHoldings({address:pinned.monero,inventory:rows,checkpoint});
            await saveNativeHoldings(value,{storage:storage.local});current();
          }
          return rows;
        }
      });
      return {account:pinned,market:value.market,client,assertCurrent:current,
        ...(value.market.view==='convert'?{signCustody:async({plan,proposal})=>{await check();const result=await call('marketSignCustody',{plan,proposal});await check();return result;}}:{})};
    },check,close,
    release(){
      if(released)return Promise.resolve();released=true;
      // Revoke first, then stop the private worker immediately. No receipt is deleted.
      const pending=runtime.sendMessage({channel:'xmr20-site-approval',requestId,action:'marketClose'});
      close();return pending.then(()=>{},()=>{});
    },
    isClosed:()=>closed
  });
}
