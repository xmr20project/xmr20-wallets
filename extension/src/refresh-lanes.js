// A slow public source cannot suppress another source's next refresh.
export function createRefreshLanes(){
 const pending=new Map();
 return {
  run(key,load){
   if(pending.has(key))return pending.get(key).task;
   const controller=new AbortController(),entry={controller};
   entry.task=Promise.resolve().then(()=>load(controller.signal)).finally(()=>{if(pending.get(key)===entry)pending.delete(key);});
   pending.set(key,entry);return entry.task;
  },
  clear(){for(const entry of pending.values())entry.controller.abort();pending.clear();},
  get size(){return pending.size;}
 };
}
