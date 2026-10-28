import {normalizeMoneroNode,DEFAULT_MONERO_NODE} from '../monero/monero-node.js';
export const AUTO_LOCK_OPTIONS=[5,15,30,60];
export const DEFAULT_AUTO_LOCK_MINUTES=15;
export const MONERO_NODE_POLICY_VERSION=1;
// Older preferences did not record whether Cake was an implicit default or a
// deliberate choice. The requested own-node rollout resets that old setting
// once. Later explicit Settings choices carry this marker and remain intact.
export function normalizePreferences(value){return {autoLockMinutes:AUTO_LOCK_OPTIONS.includes(value?.autoLockMinutes)?value.autoLockMinutes:DEFAULT_AUTO_LOCK_MINUTES,moneroNode:value?.moneroNodePolicy===MONERO_NODE_POLICY_VERSION?normalizeMoneroNode(value?.moneroNode):DEFAULT_MONERO_NODE,moneroNodePolicy:MONERO_NODE_POLICY_VERSION};}
export function idleExpired(lastActivity,now,minutes){return now-lastActivity>=normalizePreferences({autoLockMinutes:minutes}).autoLockMinutes*60000;}
export function timeoutLabel(minutes){return minutes===60?'1 hour':minutes+' minutes';}
