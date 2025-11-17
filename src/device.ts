import { KObject, kobj_create } from './kobject.js';

new KObject('devices', null);
const dev_kobj = kobj_create('dev');
new KObject('block', dev_kobj);
new KObject('char', dev_kobj);
