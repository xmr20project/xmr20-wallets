import {Buffer} from 'buffer';globalThis.Buffer=Buffer;
import React from 'react';import {createRoot} from 'react-dom/client';
import {WalletProvider} from './wallet-session.jsx';import WalletMenu from './wallet-menu.jsx';

const mount=document.getElementById('xmr20-wallet-root');if(mount)createRoot(mount).render(<WalletProvider><WalletMenu/></WalletProvider>);
