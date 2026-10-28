// Runs inside the fixed private worker. Only summary crosses its boundary;
// selected outputs and key images remain private. Match the signer's existing
// ten-block maturity policy at the independently verified scanner checkpoint.
const atomic=value=>{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw Error('Exact native funding amount required');return BigInt(value);};
export function nativeFeeFunding({outputs,locks=[],recipients=[],height,requiredRaw,maxInputs=16}){
 const tip=BigInt(height),required=atomic(requiredRaw),protectedImages=new Set([...locks,...recipients].map(v=>v.keyImage));
 let total=0n,available=0n,locked=0n,reserved=0n,carriers=0n;const candidates=[],waiting=[];
 for(const output of outputs){
  if(output.spent||output.duplicateKey)continue;const value=atomic(output.amount);total+=value;
  if(protectedImages.has(output.keyImage)){reserved+=value;continue;}
  if(output.token!==false){carriers+=value;continue;}
  const mature=BigInt(output.height)+10n;
  if(mature>tip){locked+=value;waiting.push({value,blocks:mature-tip});continue;}
  available+=value;candidates.push(output);
 }
 // Avoid rejecting a funded wallet simply because small historical coins came
 // before a sufficiently large coin in scanner order. Keep the input bound.
 candidates.sort((a,b)=>atomic(a.amount)>atomic(b.amount)?-1:atomic(a.amount)<atomic(b.amount)?1:0);
 const selected=[];let funds=0n;for(const output of candidates){if(selected.length===maxInputs||funds>=required)break;selected.push(output);funds+=atomic(output.amount);}
 const ready=funds>=required,reason=ready?'ready':available>=required?'fragmented':available+locked>=required?'confirming':reserved>0n?'reserved':'insufficient';
 waiting.sort((a,b)=>a.blocks<b.blocks?-1:a.blocks>b.blocks?1:0);let unlocking=available,blocksRemaining=null;
 for(const output of waiting){unlocking+=output.value;if(unlocking>=required){blocksRemaining=String(output.blocks);break;}}
 return {selected,summary:{ready,reason,requiredRaw,totalRaw:String(total),availableRaw:String(available),lockedRaw:String(locked),reservedRaw:String(reserved),carrierRaw:String(carriers),height:String(tip),blocksRemaining}};
}
