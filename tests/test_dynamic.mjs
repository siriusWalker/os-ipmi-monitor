import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
globalThis.BaseWidget = class { constructor(config) { this.config = config; this.id='test'; } };
globalThis.document = {documentElement:{lang:'fr'}};
globalThis.fetch = async (url,options) => {
    assert.match(url,/\.xml\?t=\d+$/);
    assert.equal(options.cache,'no-store');
    return {ok:true,text:async () => readFile(new URL('../src/opnsense/www/js/widgets' + url.split('?')[0].slice('/ui/js/widgets'.length),import.meta.url),'utf8')};
};
globalThis.DOMParser = class {
    parseFromString(source) {
        const children = [...source.matchAll(/<([a-z][a-z0-9_]*)>([^<]*)<\/\1>/g)].map(([,tagName,textContent]) =>
            ({tagName,textContent:textContent.replace(/&apos;/g,"'").replace(/&amp;/g,'&')}));
        return {documentElement:{tagName:'translations',children},querySelector:()=>null};
    }
};
const source = await readFile(new URL('../src/opnsense/www/js/widgets/Ipmimon.js',import.meta.url),'utf8');
const {default:Widget} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const widget = new Widget({});
widget.latest = {rows:[
    {name:'FAN1',value:3500,unit:'RPM',status:'ok'}, {name:'FAN2',value:3600,unit:'RPM',status:'ok'},
    {name:'FANA',value:3300,unit:'RPM',status:'ok'}, {name:'FAN3',value:null,unit:'RPM',status:'na'},
    {name:'DIMMA1 Temp',value:40,unit:'°C',status:'ok'}, {name:'DIMMA2 Temp',value:null,unit:'°C',status:'na'},
    {name:'DIMMB1 Temp',value:41,unit:'°C',status:'ok'}, {name:'DIMMB2 Temp',value:80,unit:'°C',status:'ok'},
    {name:'+12V',value:12.1,unit:'V',status:'ok'}, {name:'Intrusion',value:'0x0',unit:'',numeric:false,status:'ok'},
    {name:'ASIC Power',value:14,unit:'W',status:'ok'}
],errors:[]};
widget.prepareOptions = () => {};
let inventoryCalls = 0;
widget.ajaxCall = async path => {
    assert.equal(path,'/api/ipmimon/snapshot/inventory');
    inventoryCalls++;
    return {inventory:{
        system:{name:'Super Server'},motherboard:{product:'A2SDi-TP8F'},processor:{model:'Intel Atom'},
        bmc:{firmware_revision:'4.07',extra:[{label:'Device Revision',value:'1'}]},
        fru:[{device:'Builtin FRU Device (ID 0)',board:{manufacturer:'Supermicro',serial:'ABC123'},product:{},
            extra:[{label:'Board Mfg Date',value:'Mon Nov 9 2026'}]}],
        profile:{
        id:'supermicro-a2sdi-tp8f',
        sensor_patterns:['CPU Temp','System Temp','FAN*','DIMM*','Fan Mode','PWM zone *'],
        groups:[
            {id:'group_fan0',name:'FAN Zone 0',category:'Fans',unit:'RPM',method:'mean',members:['FAN1','FAN2']},
            {id:'group_fan1',name:'FAN Zone 1',category:'Fans',unit:'RPM',method:'mean',members:['FANA']},
            {id:'group_memory',name:'Memory Temp',category:'Temperatures',unit:'°C',method:'mean',members:['DIMM*']}
        ]
    }}};
};
let options = await widget.getWidgetOptions();
assert.equal(inventoryCalls,1);
assert.equal(options.sensor_choices.options.length,14);
assert(options.sensor_choices.options.some(choice=>choice.value===widget.sensorId('ASIC Power')));
assert(!options.sensor_choices.default.includes(widget.sensorId('ASIC Power')));
assert(options.sensor_choices.default.includes(widget.sensorId('FAN1')));
assert.equal(options.identity_choices.default.length,0);
assert(options.identity_choices.options.some(choice=>choice.value==='motherboard.product'));
assert(options.identity_choices.options.some(choice=>choice.value==='fru.0.board.serial'));
assert(options.identity_choices.options.some(choice=>choice.value==='fru.0.extra.0'));
assert(options.identity_choices.options.some(choice=>choice.value==='bmc.extra.0'));
assert.equal(options.show_identity_titles.default,'1');
assert.deepEqual(widget.identityEntries().filter(entry=>entry.id==='system.name').map(entry=>entry.value),['Super Server']);
assert.equal(Object.values(options).filter(option=>option.ipmiCheckbox).length,0);
assert.deepEqual(Object.keys(options).slice(0,3),['layout','cards_categories','solid_tiles']);
assert.equal(new Set(Object.values(options).map(option=>option.id)).size,Object.keys(options).length);
widget.settings = await widget.getWidgetConfig();
assert.deepEqual(widget.settings.identity_choices,[]);
widget.config.widget={identity_choices:['bmc.firmware_revision','fru.0.board.serial'],show_identity_titles:'0'};
widget.settings=await widget.getWidgetConfig();
assert.deepEqual(widget.settings.identity_choices,['bmc.firmware_revision','fru.0.board.serial']);
assert.equal(widget.settings.show_identity_titles,'0');
widget.config.widget={};
widget.settings=await widget.getWidgetConfig();
assert.equal(inventoryCalls,1);
let rows = widget.aggregateRows(widget.latest.rows);
assert.equal(rows.find(row=>row.id==='group_fan0').value,3550);
assert.equal(rows.find(row=>row.id==='group_memory').status,'partial');
const groups = JSON.parse(widget.settings.groups_json);
groups[2].method='median';
widget.settings.groups_json=JSON.stringify(groups);
assert.equal(widget.aggregateRows(widget.latest.rows).find(row=>row.id==='group_memory').value,41);
groups[2].method='max';
widget.settings.groups_json=JSON.stringify(groups);
assert.equal(widget.aggregateRows(widget.latest.rows).find(row=>row.id==='group_memory').value,80);
const catalog = widget.catalog();
assert.throws(()=>widget.validateGroups([{...groups[0],members:[widget.sensorId('FAN1'),widget.sensorId('+12V')]}],catalog),/unités/);
assert.throws(()=>widget.validateGroups([{...groups[0],members:['group_fan1']}],catalog),/numériques/);
assert.throws(()=>widget.validateGroups([{...groups[0],members:[widget.sensorId('Intrusion')]}],catalog),/numériques/);
assert.throws(()=>widget.validateGroups([groups[0],groups[0]],catalog),/dupliqué/);
widget.config.widget={...widget.settings,sensor_choices:[],groups_json:'[]'};
widget.settings=await widget.getWidgetConfig();
assert.deepEqual(widget.settings.sensor_choices,[]);
assert.deepEqual(JSON.parse(widget.settings.groups_json),[]);
widget.config.widget.catalog_json=JSON.stringify(catalog);
widget.latest.rows=widget.latest.rows.filter(row=>row.name!=='FAN3');
widget.settings=await widget.getWidgetConfig();
assert.equal(widget.aggregateRows(widget.latest.rows).find(row=>row.name==='FAN3').value,null);
assert.equal(widget.category({unit:'V'}),'Voltages');
assert.equal(widget.category({unit:'W'}),'Others');
assert.equal(widget.category({name:'FAN3',unit:'na',category:'Others'}),'Fans');
assert.equal(widget.category({name:'DIMM1',unit:'ns',category:'Others'}),'Temperatures');
assert.equal(widget.category({name:'Fan Mode',unit:'',category:'Others'}),'Control');
assert.equal(widget.category({name:'PWM zone 0',unit:'%',category:'Others'}),'Control');
assert.equal(widget.validateGroups([{...groups[0],category:'Fans'}],widget.catalog())[0].category,'Fans');
assert.equal(widget.tr('category_control'),'Régulation');
assert.equal(widget.backendMessage('sensors: command_unavailable'),'sensors: commande indisponible');
assert.equal(widget.backendMessage('some_readings_are_absent_or_invalid_na'),'Certaines mesures sont absentes ou invalides (na).');
assert.match(widget.formatValue({name:'+3.3V',value:3.312,unit:'V'}),/3[.,]312 V/);
assert.equal(widget.defaultLabel('CPU Temp'),'CPU Temp');
assert.equal(widget.defaultLabel('DIMMA1 Temp'),'DIMMA1 Temp');
assert.equal(widget.tr('sensors'),'Capteurs');
assert.equal(widget.tr('hardware'),'Matériel');
globalThis.document.documentElement.lang='en';
const english=new Widget({});
await english.loadLocale();
assert.equal(english.tr('sensors'),'Sensors');
assert.equal(english.tr('hardware'),'Hardware');
assert.equal(english.tr('tiles'),'Tiles');
assert.equal(english.tr('category_control'),'Fan control');
assert.equal(english.backendMessage('sensors: command_unavailable'),'sensors: command unavailable');
assert.equal(widget.defaultLabel('Fan Mode'),'Mode Ventilation');
assert.equal(english.defaultLabel('Fan Mode'),'Fan Mode');
assert.equal(widget.formatValue({name:'Fan Mode',value:'0x03 (observed)'}),'PUE2');
const generic=new Widget({});
generic.latest={rows:[{name:'Vendor X Sensor',value:7,unit:'W',status:'ok'}],errors:[]};
generic.prepareOptions=()=>{};
generic.ajaxCall=async()=>({inventory:{profile:null}});
const genericOptions=await generic.getWidgetOptions();
assert.deepEqual(genericOptions.sensor_choices.default,[generic.sensorId('Vendor X Sensor')]);
assert.deepEqual(JSON.parse(genericOptions.groups_json.default),[]);
const header = {textContent:'IPMI Monitor'};
const option = {textContent:'IPMI Monitor',parentElement:{}};
const selectData = new Map([['selectpicker',true]]);
let refreshes = 0;
globalThis.window = {jQuery:() => ({
    data:(key,value) => value === undefined ? selectData.get(key) : selectData.set(key,value),
    selectpicker:() => { refreshes++; }
})};
globalThis.document = {documentElement:{lang:'fr'},body:{},querySelector:selector =>
    selector === '#ipmimon-title b' ? header : selector === '#widget-selection option[value="ipmimon"]' ? option : null};
globalThis.MutationObserver = class { constructor(callback) { this.callback=callback; } observe() { this.callback(); } };
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#localized-title');
await new Promise(resolve => setTimeout(resolve,30));
assert.equal(header.textContent,'Moniteur IPMI');
assert.equal(option.textContent,'Moniteur IPMI');
assert.equal(refreshes,1);
console.log('PASS dynamic catalog, initial profile, unknown sensor, groups and locales.');
