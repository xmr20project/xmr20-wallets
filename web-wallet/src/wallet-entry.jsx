import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
import React,{Suspense,lazy} from 'react';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';
import {WalletProvider} from './wallet-session.jsx';import WalletMenu from './wallet-menu.jsx';
// 29 Oct 2026: /profile/ has a #xmr20-profile-root; the profile page renders there inside the same wallet session as the header.
const ProfilePage=lazy(()=>import('./profile-page.jsx'));

const mount=document.getElementById('xmr20-wallet-root'),profile=document.getElementById('xmr20-profile-root');
if(mount)createRoot(mount).render(<WalletProvider><WalletMenu/>{profile&&createPortal(<Suspense fallback={null}><ProfilePage/></Suspense>,profile)}</WalletProvider>);
