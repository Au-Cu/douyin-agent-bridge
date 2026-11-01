// Missing outgoing rows are normal in a virtualized group history. Reuse an
// identity witnessed in this authenticated browser session, never a nickname
// or an identity supplied in chat text. A changed account marker fails closed.
export function applyVerifiedIdentity(scan,witness,externalMarker){
  const marker=externalMarker??scan.accountMarker??'',same=!!witness&&(marker?marker===witness.accountMarker:!witness.accountMarker&&!!scan.documentInstance&&scan.documentInstance===witness.documentInstance);
  if(!scan.loginRequired&&!scan.diagnostics?.selfIdentityConflict&&scan.peer&&!scan.peer.selfUid&&same)return {...scan,peer:{...scan.peer,selfUid:witness.selfUid},diagnostics:{...scan.diagnostics,selfIdentified:true,selfIdentitySource:'verified_session'}};
  return scan;
}
export function bindScanIdentity(adapter,scan,externalMarker){
  const marker=externalMarker??scan.accountMarker??'';
  if(scan.loginRequired||scan.diagnostics?.selfIdentityConflict||adapter.verifiedIdentity&&marker!==adapter.verifiedIdentity.accountMarker)adapter.verifiedIdentity=null;
  if(!scan.loginRequired&&scan.peer?.selfUid)adapter.verifiedIdentity={selfUid:scan.peer.selfUid,accountMarker:marker,documentInstance:scan.documentInstance||''};
  const value=applyVerifiedIdentity(scan,adapter.verifiedIdentity,externalMarker),{accountMarker,documentInstance,...safe}=value;return safe;
}
