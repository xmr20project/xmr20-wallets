import CopyRecoveryPhrase from './copy-recovery-phrase.jsx';
import React from 'react';

export default function WalletRecovery({solanaBackup=false,address,seed,height=0,saveLocal,password,busy,saveStage='',error,onBackup,onPassword,onFinish,onBack}){
 const progress={approval:'Open Phantom or Solflare and approve the message to save this wallet. No transaction or payment is requested.',encrypting:'Encrypting and checking your backup on this device…',backup:'Saving your optional password backup…',linking:solanaBackup?'Encrypted backup saved. Linking your wallet…':'Linking your wallet…'};
 const label={approval:'Waiting for wallet approval…',encrypting:'Encrypting…',backup:'Saving backup…',linking:'Linking wallet…'};
 return <section className="wallet-recovery" aria-label="Save recovery phrase">
  <div className="wallet-recovery-intro"><span className="wallet-step-label">BACK UP YOUR WALLET</span><h3>Keep these words safe.</h3><p>Save all 25 words in order. Never share them.</p></div>
  <ol className="wallet-word-grid" aria-label="Recovery phrase">{seed.trim().split(/\s+/).map((word,i)=><li key={i}><span aria-hidden="true">{i+1}</span>{word}</li>)}</ol>
  <CopyRecoveryPhrase seed={seed} disabled={busy}/>
  <details className="wallet-address-detail"><summary>Wallet address</summary><code>{address}</code></details>
  {/* 28 Oct 2026 (owner): the creation block, to keep with the words; restoring elsewhere can start its first sync there. */}
  {height>0&&<p className="wallet-recovery-note">Created at block <strong>{height.toLocaleString()}</strong>. Keep this number with your words: when you restore this wallet in another browser, its first sync can start there.</p>}
  <label className="wallet-backup-choice"><input type="checkbox" checked={saveLocal} disabled={busy} onChange={e=>onBackup(e.target.checked)}/><span>Save an encrypted backup on this device <small>Optional</small></span></label>
  {saveLocal&&<label className="wallet-backup-password">Backup password<input type="password" autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} value={password} onChange={e=>onPassword(e.target.value)}/><small>At least 12 characters. Keep a separate copy of your phrase.</small></label>}
  <p className="wallet-recovery-note">{solanaBackup?'Your connected Solana wallet will encrypt this wallet on this device before it is linked. Keep a separate copy of these words in case browser data is cleared.':saveLocal?'Your password and recovery phrase stay on this device.':'This phrase won’t be available here after you continue.'}</p>
  {busy&&progress[saveStage]&&<p className="wallet-recovery-note" role="status" aria-live="polite">{progress[saveStage]}</p>}
  <div className="wallet-setup-actions"><button className="wallet-primary" disabled={busy||!seed||(saveLocal&&password.length<12)} onClick={onFinish}>{busy?(label[saveStage]||'Saving…'):solanaBackup?'Save with Solana wallet':'Use this wallet'}</button><button className="wallet-text-button" disabled={busy} onClick={onBack}>Back</button></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
 </section>;
}
