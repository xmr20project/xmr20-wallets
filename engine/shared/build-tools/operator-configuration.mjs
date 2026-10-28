import {resolve} from 'node:path';
// Build-time selection only; pages/API replies never configure a signer. (Same plugin as the main XMR20 repository's
// website/build-tools/operator-configuration.mjs; only its paths follow this repository's layout.)
const candidate=resolve(import.meta.dirname,'../native-market/operator-mainnet-candidate.mjs');
export function operatorConfigurationPlugin(enabled=process.env.XMR20_OPERATOR_NATIVE_CANDIDATE==='1'){
 return {name:'operator-native-candidate',setup(build){
  if(!enabled)return;
  build.onResolve({filter:/native-market-config\.js$/},()=>({path:candidate}));
 }};
}
export function operatorConfigurationVitePlugin(){
 return {name:'operator-native-candidate',enforce:'pre',resolveId(source){
  if(process.env.XMR20_OPERATOR_NATIVE_CANDIDATE==='1'&&source.endsWith('/native-market-config.js'))
   return candidate;
 }};
}
