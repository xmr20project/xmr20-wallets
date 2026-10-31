import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
import React,{Suspense,lazy} from 'react';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';
import {WalletProvider} from './wallet-session.jsx';import WalletMenu from './wallet-menu.jsx';
// 29 Oct 2026: /profile/ has a #xmr20-profile-root; the profile page renders there inside the same wallet session as the header.
const ProfilePage=lazy(()=>import('./profile-page.jsx'));
// Monero Market: /market/ has a #xmr20-market-root; the website wallet joins the market page from there (same wallet session).
const MarketWallet=lazy(()=>import('./market-website-wallet.jsx'));

// 30 Oct 2026: an error inside the profile page stays inside it (the header wallet keeps working) and offers a reload.
class ProfileBoundary extends React.Component{constructor(p){super(p);this.state={failed:false};}static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error){console.error('Profile page error:',error);}
 render(){return this.state.failed?<section className="xp-shell"><p className="small" role="alert">The profile page could not load. <button type="button" onClick={()=>location.reload()}>Reload</button></p></section>:this.props.children;}}
const mount=document.getElementById('xmr20-wallet-root'),profile=document.getElementById('xmr20-profile-root'),market=document.getElementById('xmr20-market-root');
if(mount)createRoot(mount).render(<WalletProvider><WalletMenu/>{profile&&createPortal(<ProfileBoundary><Suspense fallback={null}><ProfilePage/></Suspense></ProfileBoundary>,profile)}{market&&createPortal(<Suspense fallback={null}><MarketWallet/></Suspense>,market)}</WalletProvider>);
