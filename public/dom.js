// Patch only changed nodes. Keep native form focus, details state and scrollable
// descendants alive across polling; never recreate a whole live list.
const rendered = new WeakMap();
function key(node) {
  if (!node || node.nodeType !== 1) return null;
  for (const name of ['id', 'data-ui-key', 'data-operation', 'data-fold-key']) {
    if (node.hasAttribute(name)) return name + ':' + node.getAttribute(name);
  }
  return null;
}
const sameType = (a, b) => a?.nodeType === b.nodeType && a.nodeName === b.nodeName;
function patch(node, next) {
  if (node.nodeType !== 1) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  const focused = node === document.activeElement;
  const retained = name => (node.tagName === 'DETAILS' && name === 'open') ||
    (focused && ['value', 'checked', 'selected'].includes(name));
  for (const attr of [...node.attributes]) {
    if (!next.hasAttribute(attr.name) && !retained(attr.name)) node.removeAttribute(attr.name);
  }
  for (const attr of next.attributes) {
    if (!retained(attr.name) && node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
  }
  children(node, next);
}
function children(parent, next) {
  const keyed = new Map([...parent.childNodes].filter(n => key(n)).map(n => [key(n), n]));
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const wanted = key(desired);
    let current = wanted ? keyed.get(wanted) : (!key(cursor) && sameType(cursor, desired) ? cursor : null);
    if (current && !sameType(current, desired)) current = null;
    if (!current) current = desired.cloneNode(true);
    if (current !== cursor) parent.insertBefore(current, cursor);
    patch(current, desired);
    cursor = current.nextSibling;
  }
  while (cursor) { const old = cursor; cursor = cursor.nextSibling; old.remove(); }
}
export function updateHTML(container, html, { animate = false } = {}) {
  if (rendered.get(container) === html) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const positions = animate && !reduced ? new Map([...container.children].map(n => [n, n.getBoundingClientRect().top])) : null;
  const template = document.createElement('template');
  template.innerHTML = html;
  children(container, template.content);
  rendered.set(container, html);
  if (positions) for (const child of container.children) {
    const old = positions.get(child), dy = old === undefined ? 0 : old - child.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) child.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 160, easing: 'ease-out' });
  }
}
// Options may be regenerated when a backend/model catalog changes, never just
// because the status poll fired. The caller retains the selected value.
export function updateOptions(select, html) {
  if (select.dataset.optionsHTML === html) return;
  select.innerHTML = html;
  select.dataset.optionsHTML = html;
}

// One vocabulary for feedback, reading panels and explicit decisions in both layouts.
const configured = new WeakSet();
let confirmation = null;

export function configureDialog(dialog,{kind='workspace',dismissible=true}={}){
  dialog.classList.add('console-dialog');
  dialog.dataset.overlay=kind;
  dialog.setAttribute('aria-modal','true');
  if(kind==='danger')dialog.setAttribute('role','alertdialog');
  if(configured.has(dialog))return dialog;
  configured.add(dialog);
  let outside=false;
  const isOutside=event=>{
    const r=dialog.getBoundingClientRect();
    return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);
  };
  dialog.addEventListener('pointerdown',event=>{outside=isOutside(event);});
  dialog.addEventListener('click',event=>{
    if(outside&&isOutside(event)&&dismissible&&!dialog.querySelector('[data-dialog-busy="true"]'))dialog.close('cancel');
    outside=false;
  });
  dialog.addEventListener('cancel',event=>{
    if(dialog.querySelector('[data-dialog-busy="true"]'))event.preventDefault();
  });
  return dialog;
}

export function confirmAction({title,message,confirmLabel,context,kind='confirm',acknowledge='',anchor=document.activeElement}){
  // Do not queue a decision for an action the user can no longer see.
  if(confirmation)return Promise.resolve(false);
  let dialog=document.getElementById('actionDialog');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='actionDialog';
    dialog.setAttribute('aria-labelledby','actionHeading');dialog.setAttribute('aria-describedby','actionContext actionMessage');
    dialog.innerHTML='<p id="actionCategory" class="dialog-category"></p><h2 id="actionHeading"></h2><p id="actionContext" class="dialog-context"></p><p id="actionMessage"></p><label id="actionAcknowledgeRow" class="delete-check" hidden><input id="actionAcknowledge" type="checkbox"><span></span></label><div class="dialog-actions"><button id="cancelAction" class="secondary" autofocus>取消</button><button id="confirmAction"></button></div>';
    document.body.append(dialog);configureDialog(dialog);
    dialog.querySelector('#cancelAction').addEventListener('click',()=>dialog.close('cancel'));
    dialog.querySelector('#confirmAction').addEventListener('click',()=>dialog.close('confirm'));
    dialog.querySelector('#actionAcknowledge').addEventListener('change',event=>{dialog.querySelector('#confirmAction').disabled=!event.target.checked;});
  }
  // Safari and touch clicks need not focus the clicked button. Keep the actual
  // action source, rather than anchoring a decision to whichever field had focus.
  const $=id=>dialog.querySelector('#'+id),previousFocus=document.activeElement,trigger=anchor?.matches?.('button,a,input,select,[tabindex]')?anchor:null,parent=trigger?.closest('dialog'),route=location.hash;
  const source=trigger?JSON.stringify(trigger.dataset):'',disabled=trigger?.disabled;
  const validSource=()=>location.hash===route&&(!parent||parent.open)&&(!trigger||trigger.isConnected&&trigger.getClientRects().length>0&&JSON.stringify(trigger.dataset)===source&&(disabled||!trigger.disabled));
  if(!validSource())return Promise.resolve(false);
  const record=trigger?.closest('.work-card,.delivery-review-row,.item');
  context??=[record?.querySelector('.work-kicker')?.textContent,record?.querySelector('strong')?.textContent].filter(Boolean).join(' · ');
  const local=kind==='confirm'&&!!trigger&&typeof dialog.showPopover==='function';
  // A nonmodal popover must remain inside its source modal's subtree to avoid
  // inheriting the background's inert state.
  (parent||document.body).append(dialog);
  dialog.dataset.overlay=local?'local':kind;dialog.setAttribute('role',kind==='confirm'?'dialog':'alertdialog');
  dialog.setAttribute('aria-modal',String(!local));
  if(local)dialog.setAttribute('popover','auto');else dialog.removeAttribute('popover');
  dialog.style.removeProperty('left');dialog.style.removeProperty('top');
  $('actionCategory').textContent=kind==='danger'?'永久清理':kind==='warning'?'高影响操作':'操作确认';
  $('actionHeading').textContent=title;$('actionContext').textContent=context;$('actionContext').hidden=!context;
  $('actionMessage').textContent=message;$('confirmAction').textContent=confirmLabel;
  $('confirmAction').className=kind==='confirm'?'primary':'delete-record';
  $('actionAcknowledgeRow').hidden=!acknowledge;$('actionAcknowledgeRow').querySelector('span').textContent=acknowledge;
  $('actionAcknowledge').checked=false;$('confirmAction').disabled=!!acknowledge;
  dialog.returnValue='cancel';dialog.dataset.decision='pending';
  return new Promise(resolve=>{
    let restoreFocus=true;
    const cancel=()=>{if(dialog.open)dialog.close('cancel');};
    const lightDismiss=event=>{if(event.newState==='closed')cancel();};
    const leaveFocus=event=>{if(local&&dialog.open&&!dialog.contains(event.target)){restoreFocus=false;cancel();}};
    const place=()=>{
      if(!validSource()){cancel();return;}
      if(!local||!dialog.open)return;
      const anchor=trigger.getBoundingClientRect(),panel=dialog.getBoundingClientRect(),gap=10,margin=16;
      if(anchor.bottom<=0||anchor.top>=innerHeight||anchor.right<=0||anchor.left>=innerWidth){cancel();return;}
      const below=anchor.bottom+gap,above=anchor.top-panel.height-gap;
      dialog.style.left=Math.max(margin,Math.min(anchor.left,innerWidth-panel.width-margin))+'px';
      dialog.style.top=Math.max(margin,Math.min(below+panel.height<=innerHeight-margin?below:above,innerHeight-panel.height-margin))+'px';
    };
    const observer=new MutationObserver(place);
    const closed=()=>{
      const accepted=dialog.returnValue==='confirm'&&validSource();confirmation=null;dialog.dataset.decision=accepted?'confirm':'cancel';
      observer.disconnect();dialog.removeEventListener('beforetoggle',lightDismiss);document.removeEventListener('focusin',leaveFocus);
      window.removeEventListener('hashchange',cancel);parent?.removeEventListener('close',cancel);
      window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true);
      if(local&&dialog.matches(':popover-open'))dialog.hidePopover();
      if(dialog.parentElement!==document.body)document.body.append(dialog);
      // An outside click or Tab can continue to another field. Do not steal its
      // focus back after dismissing this nonmodal decision.
      if(restoreFocus&&(!local||dialog.contains(document.activeElement)||[trigger,previousFocus,document.body].includes(document.activeElement))&&validSource()&&trigger&&!trigger.disabled)trigger.focus({preventScroll:true});
      resolve(accepted);
    };
    confirmation={cancel};
    dialog.addEventListener('close',closed,{once:true});window.addEventListener('hashchange',cancel);parent?.addEventListener('close',cancel,{once:true});
    if(local){dialog.addEventListener('beforetoggle',lightDismiss);dialog.show();dialog.showPopover();}else dialog.showModal();
    place();$('cancelAction').focus({preventScroll:true});
    if(local){window.addEventListener('resize',place);document.addEventListener('scroll',place,true);document.addEventListener('focusin',leaveFocus);}
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden']});
    if(trigger)observer.observe(trigger,{attributes:true});
  });
}
