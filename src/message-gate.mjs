import {parseCommand} from './commands.mjs';
export class MessageGate{
  constructor(store){this.store=store;}
  control(message,ignore){
    if(this.store.config.ignoreMessages!==ignore){this.store.saveConfig({ignoreMessages:ignore});this.store.event(ignore?'已进入忽略模式；仅识别 /结束忽略':'已结束忽略模式，恢复正常接收');}
    this.discard(message,ignore?'进入忽略模式':'结束忽略模式');
  }
  discard(message,reason='忽略模式'){
    const minimal={id:message.id,peer:message.peer,platformId:message.platformId,kind:'ignored',created:message.created};this.store.incoming(minimal);
    this.store.db.prepare("UPDATE messages SET kind='ignored',body=?,status='ignored',result=? WHERE id=?").run(JSON.stringify(minimal),reason,message.id);
  }
  accept(message){
    if(this.store.db.prepare('SELECT 1 FROM messages WHERE id=?').get(message.id))return false;
    const command=message.kind==='text'&&parseCommand(message.text),valid=!command?.arg;
    if(valid&&command?.name==='ignore_end'){this.control(message,false);return false;}
    if(this.store.config.ignoreMessages){this.discard(message);return false;}
    if(valid&&command?.name==='ignore_start'){this.control(message,true);return false;}
    return true;
  }
}
