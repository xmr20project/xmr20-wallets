import {PublicKey} from '@solana/web3.js';
// Syntax admission is not launch verification or deployment certification.
export const XCAT_MINT='2qizXDtpK92YziSqmt6Kry3Zc6CNuZxjbQodqcEsZXMR';
export const XMR20_MINT='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR';
export function supportedMint(mint){try{return typeof mint==='string'&&new PublicKey(mint).toBase58()===mint;}catch{return false;}}
// Historical manifests omitted mint; their meaning stays XCAT forever.
export function deploymentMint(manifest){const mint=manifest?.mint??XCAT_MINT;if(!supportedMint(mint)||manifest?.profile!=='multi-token'&&![XCAT_MINT,XMR20_MINT].includes(mint))throw Error('Unsupported pinned bridge mint.');return mint;}
