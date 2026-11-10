const IPMI_CATEGORIES = ['Temperatures', 'Fans', 'Control', 'Voltages', 'Others'];

const ipmiLocales = new Map();
function ipmiLocale() {
    const language = String(document.documentElement?.lang || 'en').toLowerCase();
    const locale = language.startsWith('fr') ? 'fr_FR' : 'en_US';
    if (!ipmiLocales.has(locale)) ipmiLocales.set(locale, (async () => {
        try {
            const response = await fetch('/ui/js/widgets/Locales/Ipmimon_' + locale + '.xml?t=' + Date.now(), {cache:'no-store'});
            if (!response.ok) throw new Error('Locale unavailable');
            const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
            if (xml.documentElement.tagName !== 'translations' || xml.querySelector('parsererror')) throw new Error('Invalid locale');
            return Object.fromEntries([...xml.documentElement.children].map(item => [item.tagName,item.textContent]));
        } catch (error) {
            return {};
        }
    })());
    return ipmiLocales.get(locale);
}

// The dashboard gets the title from server-side gettext before this module loads.
// Apply the plugin's locale to its own header and Add Widget entry after they appear.
if (typeof MutationObserver !== 'undefined' && document.documentElement?.lang?.toLowerCase().startsWith('fr')) {
    ipmiLocale().then(locale => {
        if (!locale.title || !document.body) return;
        const updateTitle = () => {
            const header = document.querySelector('#ipmimon-title b');
            if (header && header.textContent !== locale.title) header.textContent = locale.title;
            const option = document.querySelector('#widget-selection option[value="ipmimon"]');
            if (option && option.textContent !== locale.title) {
                option.textContent = locale.title;
                const select = window.jQuery?.(option.parentElement);
                if (select?.data('selectpicker')) select.selectpicker('refresh');
            }
        };
        new MutationObserver(updateTitle).observe(document.body, {childList:true,subtree:true});
        updateTitle();
    });
}

export default class Ipmimon extends BaseWidget {
    constructor(config) {
        super(config);
        this.tickTimeout = 1;
        this.timeoutPeriod = 9000;
        this.retryLimit = 0;
        this.busy = false;
        this.configurable = true;
        this.latest = null;
        this.settings = {};
        this.nextReadingAt = 0;
        this.profile = null;
        this.profileLoaded = false;
        this.inventory = null;
        this.locale = {};
        this.fanModeEditing = false;
        this.fanModeUpdating = false;
    }

    defaultLabel(name) {
        return name === 'Fan Mode' ? this.tr('fan_mode') : name;
    }

    async loadLocale() {
        this.locale = await ipmiLocale();
    }

    tr(key) {
        return this.locale[key] || this.translations?.[key] || key;
    }

    backendMessage(text) {
        const split = String(text).match(/^([^:]+): ([a-z_]+)$/);
        return split ? split[1] + ': ' + this.tr(split[2]) : this.tr(String(text));
    }

    statusLabel(status) {
        const key = 'status_' + String(status);
        return this.locale[key] || this.translations?.[key] || String(status);
    }

    labelKey(name) {
        return 'label_' + Array.from(name).map(character => character.codePointAt(0).toString(16)).join('_');
    }

    sensorId(name) {
        return 'sensor_' + this.labelKey(name);
    }

    sensorUnit(row) {
        const unit = String(row.unit || '');
        if (!['','na','ns','n/a'].includes(unit.toLowerCase())) return unit;
        if (/^fan(?!.*(?:mode|pwm))/i.test(row.name)) return 'RPM';
        if (/temp|thermal/i.test(row.name) || /^dimm[a-z0-9_-]*$/i.test(row.name) || /^(cpu|system|peripheral)$/i.test(row.name)) return '°C';
        return unit;
    }

    parseList(value) {
        try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; }
        catch (error) { return []; }
    }

    parseLabels(value) {
        try {
            const labels = JSON.parse(value || '{}');
            if (!labels || Array.isArray(labels) || typeof labels !== 'object') return {};
            return Object.fromEntries(Object.entries(labels).filter(([key,label]) => typeof key === 'string' && typeof label === 'string')
                .map(([key,label]) => [key,label.slice(0,80)]));
        } catch (error) { return {}; }
    }

    catalog() {
        const stored = this.parseList(this.config?.widget?.catalog_json).filter(row => row && typeof row.name === 'string');
        const map = new Map();
        for (const row of [...stored, ...(this.latest?.rows || [])].slice(0, 1024)) {
            const id = this.sensorId(row.name);
            const unit = this.sensorUnit(row).slice(0,32);
            map.set(id, {id, name: row.name.slice(0, 128), unit,
                category: this.category({...row,unit}), numeric: unit !== String(row.unit || '') || (row.numeric ?? ['°C', 'RPM', 'V', '%', 'A', 'W'].includes(unit))});
        }
        return [...map.values()];
    }

    templateMatches(name, pattern) {
        if (typeof pattern !== 'string') return false;
        const target = String(name).toLowerCase();
        const expected = pattern.toLowerCase();
        return expected.endsWith('*') ? target.startsWith(expected.slice(0, -1)) : target === expected;
    }

    async loadProfile() {
        if (this.profileLoaded) return;
        this.profileLoaded = true;
        try {
            const data = await this.ajaxCall('/api/ipmimon/snapshot/inventory');
            if (data?.inventory && typeof data.inventory === 'object') this.inventory = data.inventory;
            const profile = data?.inventory?.profile;
            if (profile && Array.isArray(profile.sensor_patterns) && Array.isArray(profile.groups)) this.profile = profile;
        } catch (error) {
            this.profile = null;
        }
    }

    identityEntries() {
        const inventory = this.inventory || {};
        const entries = [];
        const add = (id, label, value) => {
            if (typeof value === 'string' && value.trim()) entries.push({id, label, value:value.trim().slice(0,128)});
        };
        add('system.name', this.tr('system'), inventory.system?.name);
        add('motherboard.product', this.tr('motherboard'), inventory.motherboard?.product);
        add('processor.model', this.tr('processor'), inventory.processor?.model);
        const bmcFields = {
            manufacturer_name:'manufacturer', product_name:'product', firmware_revision:'firmware',
            ipmi_version:'ipmi_version', device_id:'device_id', manufacturer_id:'manufacturer_id', product_id:'product_id'
        };
        for (const [key, label] of Object.entries(bmcFields)) add('bmc.' + key, 'BMC · ' + this.tr(label), inventory.bmc?.[key]);
        (Array.isArray(inventory.bmc?.extra) ? inventory.bmc.extra : []).slice(0,64).forEach((item, index) =>
            add('bmc.extra.' + index, 'BMC · ' + String(item?.label || '').slice(0,64), item?.value));
        const fruFields = {
            chassis:{type:'type',part_number:'part_number',serial:'serial_number'},
            board:{manufacturer:'manufacturer',product:'product',part_number:'part_number',serial:'serial_number'},
            product:{manufacturer:'manufacturer',name:'model',part_number:'part_number',version:'version',serial:'serial_number',asset_tag:"asset_tag"}
        };
        (Array.isArray(inventory.fru) ? inventory.fru : []).slice(0,32).forEach((device, index) => {
            const prefix = 'FRU ' + (index + 1);
            add('fru.' + index + '.device', prefix + ' · ' + this.tr('device'), device?.device);
            for (const [section, fields] of Object.entries(fruFields)) {
                for (const [key, label] of Object.entries(fields)) {
                    add('fru.' + index + '.' + section + '.' + key,
                        prefix + ' · ' + this.tr({chassis:'chassis',board:'board',product:'product'}[section]) + ' · ' + this.tr(label), device?.[section]?.[key]);
                }
            }
            (Array.isArray(device?.extra) ? device.extra : []).slice(0,64).forEach((item, extraIndex) =>
                add('fru.' + index + '.extra.' + extraIndex, prefix + ' · ' + String(item?.label || '').slice(0,64), item?.value));
        });
        return entries;
    }

    defaultGroups(catalog) {
        return (this.profile?.groups || []).slice(0, 32).map(group => ({
            ...group,
            members: catalog.filter(row => row.numeric && row.unit === group.unit &&
                group.members?.some(pattern => this.templateMatches(row.name, pattern))).map(row => row.id).slice(0, 256)
        })).filter(group => group.members.length);
    }

    validateGroups(groups, catalog) {
        const ids = new Set();
        const categories = IPMI_CATEGORIES;
        if (groups.length > 32) throw new Error(this.tr('maximum_32_groups'));
        return groups.map(group => {
            if (!group || !/^group_[a-zA-Z0-9_-]{1,64}$/.test(group.id) || ids.has(group.id)) throw new Error(this.tr('invalid_or_duplicate_group_identifier'));
            ids.add(group.id);
            if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80) throw new Error(this.tr('each_group_needs_a_name_maximum_80_characters'));
            const category = group.category;
            if (!categories.includes(category) || !['mean','median','max'].includes(group.method)) throw new Error(this.tr('invalid_category_or_calculation'));
            if (!Array.isArray(group.members) || group.members.length > 256) throw new Error(this.tr('invalid_group_sources'));
            const members = [...new Set(group.members)];
            const sources = members.map(id => catalog.find(row => row.id === id));
            if (sources.some(row => !row || !row.numeric)) throw new Error(this.tr('numeric_sensor_sources_only_nested_groups_are_not_allowed'));
            const units = [...new Set(sources.map(row => row.unit))];
            if (units.length > 1) throw new Error(this.tr('a_group_cannot_mix_units'));
            return {id:group.id,name:group.name.trim(),category,method:group.method,members,unit:units[0] || String(group.unit || '').slice(0,32)};
        });
    }

    aggregateRows(rows) {
        const aggregate = (group, sources) => {
            const valid = sources.filter(row => typeof row.value === 'number' && Number.isFinite(row.value));
            const values = valid.map(row => row.value).sort((first, second) => first - second);
            const method = group.method;
            let value = null;
            if (values.length) {
                const middle = Math.floor(values.length / 2);
                value = method === 'max' ? values[values.length - 1] : method === 'median'
                    ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2)
                    : values.reduce((total, number) => total + number, 0) / values.length;
            }
            const status = !valid.length ? 'na' : valid.some(row => row.status !== 'ok') ? 'alert' :
                valid.length < sources.length ? 'partial' : 'ok';
            const methodLabel = this.tr({mean: 'mean', median: 'median', max: 'maximum'}[method] || 'mean');
            return {...group, value, status, sources: methodLabel + ' ; ' + sources.map(row => row.name).join(', ') + ' ; ' + valid.length + '/' + sources.length + ' ' + this.tr('available')};
        };
        const catalog = this.catalog();
        const sensors = catalog.map(sensor => ({...sensor, value:null, status:'na', ...rows.find(row => row.name === sensor.name), id:sensor.id,name:sensor.name,unit:sensor.unit,category:sensor.category}));
        const groups = this.validateGroups(this.parseList(this.settings.groups_json), catalog);
        return [...sensors, ...groups.map(group => aggregate(group, group.members.map(id => sensors.find(row => row.id === id))))];
    }

    prepareOptions(options) {
        if (typeof MutationObserver === 'undefined') return;
        this.optionObserver?.disconnect();
        const prepare = () => {
            let missing = false;
            const holder = input => {
                const row = $(input).closest('.widget-option-container');
                return row.length ? row : $(input).parent();
            };
            const updateVisibility = () => {
                const cards = $(document.getElementById(options.layout.id)).val() === 'cards';
                for (const option of Object.values(options).filter(option => option.tileOnly)) {
                    const input = document.getElementById(option.id);
                    if (!input) continue;
                    const row = holder(input);
                    row.toggle(cards);
                    row.data('ipmimonHeading')?.toggle(cards);
                }
            };
            for (const option of Object.values(options)) {
                const input = document.getElementById(option.id);
                if (!input) { missing = true; continue; }
                const row = holder(input);
                if (option.sectionTitle && !row.data('ipmimonHeading') && !row.data('ipmimonCompact')) {
                    const heading = $('<div>').text(option.sectionTitle).css({fontWeight: 700, marginTop: '20px', borderTop: '1px solid #ddd', paddingTop: '12px'}).insertBefore(row);
                    row.data('ipmimonHeading', heading);
                }
                if (option.hidden) row.hide();
            }
            const groupsInput = document.getElementById(options.groups_json.id);
            const labelsInput = document.getElementById(options.labels_json.id);
            if (!missing && groupsInput && labelsInput && !$(groupsInput).data('ipmimonEditor')) {
                $(groupsInput).data('ipmimonEditor', true);
                this.buildEditors(options);
                this.compactOptions(options);
            }
            const layout = document.getElementById(options.layout.id);
            if (layout) $(layout).off('change.ipmimonOptions').on('change.ipmimonOptions', updateVisibility);
            updateVisibility();
            if (!missing) this.optionObserver?.disconnect();
        };
        this.optionObserver = new MutationObserver(prepare);
        this.optionObserver.observe(document.body, {childList: true, subtree: true});
        prepare();
    }

    compactOptions(options) {
        const row = key => $(document.getElementById(options[key].id)).closest('.widget-option-container');
        const parent = row('layout').parent();
        parent.addClass('ipmimon-options');
        if (!document.getElementById('ipmimon-responsive-options')) $('<style>').attr('id','ipmimon-responsive-options').text(`
            .ipmimon-options .bootstrap-select { width:100% !important; max-width:100%; min-width:0; }
            .ipmimon-options select { max-width:100%; box-sizing:border-box; }
            .ipmimon-options .bootstrap-select > button { width:100%; max-width:100%; overflow:hidden; }
            .ipmimon-options .filter-option-inner-inner { overflow:hidden; text-overflow:ellipsis; }
            .ipmimon-select-menu { max-width:calc(100vw - 16px); }
            .ipmimon-select-menu > .dropdown-menu { width:100%; min-width:0 !important; max-width:100%; }
            .ipmimon-select-menu .dropdown-menu.inner { min-width:0; overflow-x:hidden; }
            .ipmimon-select-menu .text { white-space:normal; overflow-wrap:anywhere; }
            .ipmimon-select-menu .dropdown-menu li a .text { display:block; width:100%; }
            .ipmimon-hardware-entry { display:flex; align-items:baseline; gap:12px; width:100%; min-width:0; box-sizing:border-box; padding-right:24px; }
            .ipmimon-hardware-label { flex:1 1 45%; min-width:0; text-align:left; white-space:normal; overflow-wrap:anywhere; }
            .ipmimon-hardware-value { flex:0 1 55%; min-width:0; text-align:right; white-space:normal; overflow-wrap:anywhere; }
        `).appendTo(document.head);
        for (const [key,option] of Object.entries(options)) {
            const holder = row(key);
            holder.data('ipmimonCompact',true);
            holder.data('ipmimonHeading')?.remove();
            holder.removeData('ipmimonHeading');
            holder.children('b').remove();
            holder.children('div').filter((index,element) => $(element).children('b').length > 0).remove();
            holder.css({margin:0,minWidth:0});
        }
        const section = (title, keys, stacked = false) => {
            const block = $('<div>').addClass('ipmimon-option-section').css({display:'flex',flexWrap:'wrap',alignItems:'center',gap:'10px 16px',borderTop:'1px solid #ddd',padding:'12px 0'});
            block.append($('<strong>').text(this.tr(title)).css({flex:stacked?'0 0 100%':'0 0 75px'}));
            for (const key of keys) row(key).css({flex:stacked?'1 1 100%':'1 1 170px'}).appendTo(block);
            block.appendTo(parent);
            return block;
        };
        const caption = (key,text) => row(key).prepend($('<span>').text(this.tr(text)).css({display:'inline-block',marginRight:'8px'}));
        const fru = Array.isArray(this.inventory?.fru) ? this.inventory.fru : [];
        const systemName = fru.find(device => device?.product?.name)?.product.name || this.inventory?.system?.name;
        const boardName = this.inventory?.motherboard?.product || fru.find(device => device?.board?.product)?.board.product;
        if (systemName || boardName) {
            parent.prepend($('<div>').css({padding:'0 0 12px',fontWeight:600,overflowWrap:'anywhere'})
                .text([systemName,boardName].filter(Boolean).join(' - ')));
        }
        const presentation = section('display',['layout','refresh_interval']);
        presentation.css({borderTop:0});
        const checkboxOption = (key,title,checkedValue) => {
            const original = $(document.getElementById(options[key].id));
            if (original.data('selectpicker')) original.selectpicker('destroy');
            original.removeClass('widget_optionsform_selectpicker').hide();
            const checkbox = $('<input>').attr('type','checkbox').prop('checked',original.val() === checkedValue);
            checkbox.on('change', () => original.val(checkbox.prop('checked') ? checkedValue : checkedValue === '1' ? '0' : '1'));
            row(key).prepend($('<label>').css({display:'inline-flex',gap:'8px',alignItems:'center',margin:0}).append(checkbox,$('<span>').text(this.tr(title))));
        };
        checkboxOption('cards_categories','separate_categories','1');
        caption('solid_tiles','solid');
        const tiles = section('tiles',['cards_categories','solid_tiles']);
        row('cards_categories').data('ipmimonHeading',tiles);
        checkboxOption('hide_na',"show_na",'0');
        caption('show_status','sensor_status');
        const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
        const hardwareEntries = new Map(this.identityEntries().map(entry => [entry.id,entry]));
        const hardwareInput = $(document.getElementById(options.identity_choices.id));
        hardwareInput.data('selectedTextFormat','count > 3');
        hardwareInput.find('option').each((index, element) => {
            const entry = hardwareEntries.get(element.value);
            if (!entry) return;
            $(element).attr('title',entry.label).attr('data-content', '<span class="ipmimon-hardware-entry"><span class="ipmimon-hardware-label">' +
                escapeHtml(entry.label) + '</span><span class="ipmimon-hardware-value">' + escapeHtml(entry.value) + '</span></span>');
        });
        if (hardwareInput.data('selectpicker')) hardwareInput.selectpicker('refresh');
        checkboxOption('show_identity_titles','show_field_title','1');
        section('hardware',['identity_choices','show_identity_titles'],true);
        section('sensors',['sensor_choices'],true);
        section('readings',['hide_na','show_status']);
        section('groups',['groups_json'],true);
        section('fields',['labels_json'],true);
        for (const option of Object.values(options)) {
            const input = $(document.getElementById(option.id));
            if (option.type.startsWith('select') && input.is(':visible')) this.fitOptionSelect(input);
            else if (option.type.startsWith('select') && input.hasClass('widget_optionsform_selectpicker')) this.fitOptionSelect(input);
        }
    }

    fitOptionSelect(input) {
        if (input.data('ipmimonFit')) return;
        input.data('ipmimonFit',true).attr('data-width','100%').data({width:'100%',size:8,windowPadding:[8,8,8,8],dropdownAlignRight:'auto'}).css({width:'100%',minWidth:0});
        const stylePicker = () => {
            const picker = input.data('selectpicker');
            if (!picker) return;
            picker.$newElement.css({width:'100%',minWidth:0,maxWidth:'100%'});
            picker.$bsContainer?.addClass('ipmimon-select-menu');
        };
        input.on('loaded.bs.select.ipmimonFit refreshed.bs.select.ipmimonFit shown.bs.select.ipmimonFit',stylePicker);
        if (input.data('selectpicker')) input.selectpicker('refresh');
        stylePicker();
    }

    buildEditors(options) {
        const catalog = this.catalog();
        const groupsField = $(document.getElementById(options.groups_json.id)).hide();
        const labelsField = $(document.getElementById(options.labels_json.id)).hide();
        let groups = this.validateGroups(this.parseList(groupsField.val()), catalog);
        const labels = this.parseLabels(labelsField.val());
        const editor = $('<div>').addClass('ipmimon-groups').insertAfter(groupsField);
        const labelEditor = $('<div>').addClass('ipmimon-labels').insertAfter(labelsField);
        const selection = $(document.getElementById(options.sensor_choices.id));
        const solid = $(document.getElementById(options.solid_tiles.id));
        const notice = $('<div>').addClass('text-danger').attr('role','alert');
        const categories = IPMI_CATEGORIES;
        const persist = () => {
            try {
                const validated = this.validateGroups(groups, catalog);
                groupsField.val(JSON.stringify(validated));
                notice.text('');
                editor.closest('.modal-content').find('.bootstrap-dialog-footer-buttons button:first').prop('disabled',false);
            } catch (error) {
                groupsField.val('INVALID');
                notice.text(error.message);
                editor.closest('.modal-content').find('.bootstrap-dialog-footer-buttons button:first').prop('disabled',true);
            }
        };
        const drawLabels = () => {
            labelEditor.empty();
            const selected = selection.val() || [];
            for (const row of [...catalog,...groups].filter(row => selected.includes(row.id))) {
                const input = $('<input>').attr({type:'text',maxlength:80}).addClass('form-control').val(labels[row.id] || this.defaultLabel(row.name));
                input.on('input', () => { labels[row.id] = input.val(); labelsField.val(JSON.stringify(labels)); });
                input.css({flex:'2 1 140px',minWidth:0,width:0,margin:0});
                labelEditor.append($('<label>').css({display:'flex',flexWrap:'wrap',alignItems:'center',gap:'8px',margin:'6px 0'}).append($('<span>').text(row.name).css({flex:'1 1 100px',overflowWrap:'anywhere'}),input));
            }
            if (!selected.length) labelEditor.append($('<div>').addClass('text-muted').text(this.tr('select_sensors_or_groups_above')));
        };
        const refreshChoices = () => {
            const entries = [...catalog,...groups];
            for (const field of [selection,solid]) {
                const selected = field.val() || [];
                field.empty();
                for (const category of categories) {
                    const optgroup = $('<optgroup>').attr('label',this.tr('category_' + category.toLowerCase()));
                    for (const row of entries.filter(row => this.category(row) === category)) optgroup.append($('<option>').val(row.id).text(this.defaultLabel(row.name) + (row.id.startsWith('group_') ? this.tr('group_suffix') : '')));
                    if (optgroup.children().length) field.append(optgroup);
                }
                field.val(selected);
                if (field.data('selectpicker')) field.selectpicker('refresh');
            }
            drawLabels();
        };
        const drawGroups = () => {
            editor.find('.ipmimon-members').each((index, element) => { if ($(element).data('selectpicker')) $(element).selectpicker('destroy'); });
            editor.empty().css({display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,180px),1fr))',gap:'8px',alignItems:'start'});
            for (const group of groups) {
                const box = $('<details>').addClass('ipmimon-group').prop('open',group.id === this.openGroupId).css({border:'1px solid #ddd',padding:'8px',borderRadius:'4px',minWidth:0,gridColumn:group.id === this.openGroupId?'1 / -1':'auto'});
                const summary = $('<summary>').text(group.name).css({fontWeight:600,cursor:'pointer',marginBottom:'8px'});
                box.append(summary).on('toggle', () => { box.css('grid-column',box.prop('open')?'1 / -1':'auto'); if (box.prop('open')) this.openGroupId = group.id; });
                const field = (title, control) => box.append($('<label>').css({display:'block',marginBottom:'8px'}).append($('<span>').text(this.tr(title)),control));
                const name = $('<input>').attr({type:'text',maxlength:80}).addClass('form-control').val(group.name);
                name.on('input', () => { group.name = name.val(); summary.text(group.name); persist(); refreshChoices(); });
                field('name',name);
                const category = $('<select>').addClass('form-control');
                for (const title of categories) category.append($('<option>').val(title).text(this.tr('category_' + title.toLowerCase())));
                category.val(group.category).on('change', () => { group.category = category.val(); persist(); refreshChoices(); });
                field('category',category);
                const unit = $('<select>').addClass('form-control');
                const units = [...new Set([...catalog.filter(row => row.numeric).map(row => row.unit),group.unit].filter(Boolean))];
                for (const value of units) unit.append($('<option>').val(value).text(value));
                unit.val(group.unit || units[0]);
                field('source_unit',unit);
                const method = $('<select>').addClass('form-control');
                for (const [value,title] of [['mean','mean'],['median','median'],['max','highest_value']]) method.append($('<option>').val(value).text(this.tr(title)));
                method.val(group.method).on('change', () => { group.method = method.val(); persist(); });
                field('calculation',method);
                const members = $('<select>').attr({multiple:'multiple',size:4}).addClass('form-control ipmimon-members');
                for (const row of catalog.filter(row => row.numeric && row.unit === (group.unit || unit.val()))) members.append($('<option>').val(row.id).text(row.name));
                members.val(group.members).on('change', () => { group.members = members.val() || []; group.unit = unit.val() || ''; persist(); });
                field('source_sensors',members);
                unit.on('change', () => { group.unit = unit.val(); group.members = []; persist(); drawGroups(); });
                box.append($('<button>').attr('type','button').addClass('btn btn-default ipmimon-remove-group').text(this.tr('remove_group')).on('click', () => {
                    groups = groups.filter(candidate => candidate.id !== group.id); persist(); drawGroups(); refreshChoices();
                }));
                editor.append(box);
                if (typeof members.selectpicker === 'function') {
                    members.selectpicker({container:'body',liveSearch:true,width:'100%',size:8,windowPadding:8,noneSelectedText:this.tr('choose_sensors')});
                    this.fitOptionSelect(members);
                }
            }
            editor.append($('<button>').attr('type','button').addClass('btn btn-default ipmimon-add-group').text(this.tr('add_group')).prop('disabled',groups.length >= 32).on('click', () => {
                this.openGroupId = 'group_' + crypto.randomUUID().replace(/-/g,'');
                groups.push({id:this.openGroupId,name:this.tr('new_group'),category:'Temperatures',unit:'°C',method:'mean',members:[]});
                persist(); drawGroups(); refreshChoices();
            }),notice);
        };
        selection.off('change.ipmimonSensors').on('change.ipmimonSensors',drawLabels);
        editor.closest('.modal').one('hidden.bs.modal.ipmimonGroups', () => {
            editor.find('.ipmimon-members').each((index,element) => { if ($(element).data('selectpicker')) $(element).selectpicker('destroy'); });
        });
        drawGroups();
        refreshChoices();
    }

    onWidgetClose() {
        this.optionObserver?.disconnect();
        this.tileObserver?.disconnect();
        super.onWidgetClose();
    }

    applyTileOccupancy() {
        const element = document.getElementById(this.contentId);
        if (!element?.querySelectorAll) return;
        let changed = false;
        for (const grid of element.querySelectorAll('[data-ipmimon-grid]')) {
            const columns = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length;
            for (const tile of grid.querySelectorAll('[data-ipmimon-tile]')) {
                const selected = this.settings.solid_tiles || [];
                const span = selected.includes(tile.getAttribute('data-ipmimon-tile')) && columns === 2 ? '1 / -1' : 'auto';
                if (tile.style.gridColumn !== span) {
                    tile.style.gridColumn = span;
                    changed = true;
                }
            }
        }
        if (changed) this.config?.callbacks?.updateGrid?.();
    }

    onWidgetResize() {
        this.applyTileOccupancy();
        return false;
    }

    async getWidgetOptions() {
        await this.loadLocale();
        if (!this.latest) {
            try {
                const data = await this.ajaxCall('/api/ipmimon/snapshot/get');
                if (Array.isArray(data.rows)) this.latest = data;
            } catch (error) {
                this.latest = null;
            }
        }
        const stored = this.config?.widget || {};
        const firstUse = !Array.isArray(stored.sensor_choices) && typeof stored.groups_json !== 'string' &&
            typeof stored.catalog_json !== 'string';
        await this.loadProfile();
        const catalog = this.catalog();
        const groups = this.validateGroups(typeof stored.groups_json === 'string' ? this.parseList(stored.groups_json) : this.defaultGroups(catalog), catalog);
        const entries = [...catalog, ...groups];
        const suggested = firstUse && this.profile ? entries.filter(row => row.id.startsWith('group_') ||
            this.profile.sensor_patterns.some(pattern => this.templateMatches(row.name, pattern))) : entries;
        const defaultSelection = (suggested.length ? suggested : entries).map(row => row.id);
        const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
        const choices = entries.map(row => ({value:row.id,label:escape(this.defaultLabel(row.name))}));
        const options = {
            layout: {title: 'presentation', type: 'select', options: [
                {value: 'grouped', label: 'grouped_list'}, {value: 'compact', label: 'compact_list'},
                {value: 'cards', label: 'tiles'}], default: 'grouped'},
            refresh_interval: {title: 'refresh_interval', type: 'select', options: [
                {value: '2', label: '2 s'}, {value: '5', label: '5 s'},
                {value: '10', label: '10 s'}, {value: '20', label: '20 s'},
                {value: '30', label: '30 s'}, {value: '60', label: '60 s'},
                {value: '120', label: '120 s'}], default: '10'},
            cards_categories: {title: 'tiles_separate_categories', type: 'select', options: [
                {value: '0', label: 'no_continuous_grid'}, {value: '1', label: 'yes_one_grid_per_category'}], default: '0'},
            hide_na: {title: 'unavailable_readings', type: 'select', options: [
                {value: '0', label: 'show'}, {value: '1', label: 'hide'}], default: '0'},
            show_status: {title: 'sensor_status', type: 'select', options: [
                {value: '0', label: 'on_hover_only'}, {value: '1', label: 'show'}], default: '0'}
        };
        options.sensor_choices = {title:'sensors_to_display',type:'select_multiple',options:choices,default:defaultSelection,entries};
        options.identity_choices = {title:'information_to_display',type:'select_multiple',
            options:this.identityEntries().map(entry => ({value:entry.id,label:escape(entry.label + ' — ' + entry.value)})),
            default:[]};
        options.show_identity_titles = {title:'show_field_title',type:'select',options:[
            {value:'1',label:'show'}, {value:'0',label:'hide'}],default:'1'};
        options.groups_json = {title:'add_edit_or_remove_a_group',type:'textarea',default:JSON.stringify(groups),maxlength:65536,groupEditor:true};
        options.catalog_json = {type:'textarea',title:'catalog',default:JSON.stringify(catalog),maxlength:131072,hidden:true};
        const labels = this.parseLabels(stored.labels_json);
        for (const row of entries) if (!(row.id in labels)) labels[row.id] = this.defaultLabel(row.name);
        options.labels_json = {title:'labels_for_selected_items',type:'textarea',default:JSON.stringify(labels),maxlength:65536,sectionTitle:'displayed_fields_and_labels'};
        options.solid_tiles = {title: 'solid_tiles', type: 'select_multiple',
            options: choices, default: []};
        options.cards_categories.tileOnly = true;
        options.cards_categories.sectionTitle = 'tiles';
        options.solid_tiles.tileOnly = true;
        options.hide_na.sectionTitle = 'reading_display';
        options.groups_json.sectionTitle = 'custom_groups';
        options.sensor_choices.sectionTitle = 'sensors';
        for (const [key, option] of Object.entries(options)) {
            option.id = 'ipmimon-' + this.id + '-v3-' + key;
            option.title = this.tr(option.title);
            if (option.sectionTitle) option.sectionTitle = this.tr(option.sectionTitle);
            if (!['sensor_choices','solid_tiles'].includes(key)) for (const choice of option.options || []) choice.label = this.tr(choice.label);
        }
        const ordered = {};
        for (const key of ['layout', 'refresh_interval', 'cards_categories', 'solid_tiles', 'identity_choices', 'show_identity_titles', 'sensor_choices',
            'hide_na', 'show_status', ...Object.keys(options)]) ordered[key] = options[key];
        this.prepareOptions(ordered);
        return ordered;
    }

    async getWidgetConfig() {
        const definitions = await this.getWidgetOptions();
        const stored = this.config?.widget || {};
        const clean = {};
        for (const [key, option] of Object.entries(definitions)) {
            const value = stored[key];
            if (option.type === 'select_multiple') {
                clean[key] = Array.isArray(value) ? [...new Set(value)].filter(name =>
                    key === 'identity_choices' ? typeof name === 'string' && /^(?:system|motherboard|processor|bmc|fru)\.[a-z0-9_.]{1,80}$/.test(name) :
                        option.options.some(choice => choice.value === name)).slice(0,128) : option.default;
                continue;
            }
            if (key === 'catalog_json') { clean[key] = JSON.stringify(this.catalog()); continue; }
            if (key === 'labels_json') { clean[key] = JSON.stringify(this.parseLabels(value ?? option.default)); continue; }
            if (key === 'groups_json') {
                const raw = typeof value === 'string' ? value : option.default;
                let parsed;
                try { parsed = JSON.parse(raw); } catch (error) { throw new Error(this.tr('invalid_group_configuration')); }
                if (!Array.isArray(parsed)) throw new Error(this.tr('invalid_group_list'));
                clean[key] = JSON.stringify(this.validateGroups(parsed, this.catalog()));
                continue;
            }
            clean[key] = typeof value === 'string' && value.length &&
                (option.type !== 'select' || option.options.some(choice => choice.value === value)) &&
                (!option.ipmiCheckbox || ['0', '1'].includes(value)) ? value.slice(0, 80) : option.default;
        }
        return clean;
    }

    async onWidgetOptionsChanged(options) {
        this.config = this.config || {};
        const previous = this.config.widget;
        this.config.widget = options;
        try { this.settings = await this.getWidgetConfig(); }
        catch (error) { this.config.widget = previous; throw error; }
        this.fanModeEditing = false;
        this.render();
        this.nextReadingAt = 0;
        await this.onWidgetTick();
    }

    category(row) {
        const category = row.category;
        if (row.id?.startsWith('group_') && IPMI_CATEGORIES.includes(category)) return category;
        if (row.name === 'Fan Mode' || /^PWM zone /.test(row.name)) return 'Control';
        const inferred = this.sensorUnit(row);
        if (inferred === 'RPM') return 'Fans';
        if (inferred === '°C') return 'Temperatures';
        if (inferred === 'V') return 'Voltages';
        if (IPMI_CATEGORIES.includes(category)) return category;
        return 'Others';
    }

    formatValue(row) {
        if (row.value === null || row.value === undefined) return 'na';
        if (row.name === 'Fan Mode') {
            const mode = /^0x([0-9a-f]{2})\b/i.exec(String(row.value));
            if (mode) return this.fanModeChoices().find(choice => choice.code === mode[1].toLowerCase())?.label || mode[0];
        }
        const value = typeof row.value === 'number' ? new Intl.NumberFormat(undefined, {maximumFractionDigits: ['V','A'].includes(row.unit) ? 3 : 1}).format(row.value) : String(row.value);
        return value + (row.unit ? ' ' + row.unit : '');
    }

    fanModeChoices() {
        return (this.profile?.fan_modes || []).filter(mode => mode &&
            /^[a-z][a-z0-9_]{0,31}$/.test(mode.id) && /^0[0-4]$/.test(mode.code) &&
            typeof mode.name === 'string' && mode.name.length > 0 && mode.name.length <= 80)
            .map(mode => ({value:mode.id,code:mode.code,label:mode.name}));
    }

    fanModePicker(row, layout) {
        const choices = this.fanModeChoices();
        const current = /^0x([0-9a-f]{2})\b/i.exec(String(row.value || ''))?.[1].toLowerCase();
        const picker = $('<div>').css({display:'flex',flexDirection:'column',gap:'4px',
            flex:layout === 'cards' ? '0 0 auto' : '1 1 155px',width:layout === 'cards' ? '100%' : 'auto',
            minWidth:layout === 'cards' ? 0 : 'min(100%, 155px)'});
        const controls = $('<div>').css({display:'flex',alignItems:'center',justifyContent:'flex-end',
            flexWrap:layout === 'cards' ? 'wrap' : 'nowrap',gap:'4px',width:'100%',minWidth:0});
        const select = $('<select>').addClass('form-control').attr('aria-label',this.tr('fan_mode'))
            .css({flex:layout === 'cards' ? '1 1 80px' : '1 1 0%',width:layout === 'cards' ? 'auto' : 0,
                minWidth:layout === 'cards' ? 'min(100%, 60px)' : 0});
        for (const choice of choices) select.append($('<option>').val(choice.value).text(choice.label));
        select.val(choices.find(choice => choice.code === current)?.value || 'standard');
        const iconButton = (title, icon, style) => $('<button>').attr({type:'button',title,'aria-label':title})
            .addClass('btn btn-xs ' + style).css({flex:'0 0 26px',width:'26px',height:'26px',padding:0,
                display:'inline-flex',alignItems:'center',justifyContent:'center',fontSize:'16px',lineHeight:1}).text(icon);
        const apply = iconButton(this.tr('apply_fan_mode'),'✓','btn-primary');
        const cancel = iconButton(this.tr('cancel_fan_mode'),'×','btn-default');
        const message = $('<small>').css({display:'none'});
        picker.on('click keydown', event => event.stopPropagation());
        cancel.on('click', () => { this.fanModeEditing = false; this.render(); });
        apply.on('click', async () => {
            const selected = choices.find(choice => choice.value === select.val());
            if (!selected || !window.confirm(this.tr('confirm_fan_mode_change') + ' ' + selected.label + '?')) return;
            apply.prop('disabled',true);
            cancel.prop('disabled',true);
            this.fanModeUpdating = true;
            message.text(this.tr('changing_fan_mode')).removeClass('text-danger').show();
            try {
                const result = await $.ajax({url:'/api/ipmimon/fan/set',type:'POST',
                    data:JSON.stringify({mode:selected.value}),contentType:'application/json',dataType:'json',timeout:40000});
                if (result?.status !== 'ok' || result.mode !== '0x' + selected.code.toUpperCase()) throw new Error('Fan mode change failed');
                const live = this.latest?.rows?.find(reading => reading.name === 'Fan Mode');
                if (live) live.value = result.mode;
                this.fanModeEditing = false;
                this.nextReadingAt = Date.now() + 2500;
                this.render();
            } catch (error) {
                message.text(this.tr('fan_mode_change_failed')).addClass('text-danger').show();
                apply.prop('disabled',false);
                cancel.prop('disabled',false);
            } finally {
                this.fanModeUpdating = false;
            }
        });
        picker.append(controls.append(select,apply,cancel),message);
        return picker;
    }

    render() {
        const element = document.getElementById(this.contentId);
        if (!element || !this.latest) return;
        const container = $(element).empty();
        const labels = this.parseLabels(this.settings.labels_json);
        let rows = this.aggregateRows(this.latest.rows);
        rows = rows.filter(row => (this.settings.sensor_choices || []).includes(row.id));
        if (this.settings.hide_na === '1') rows = rows.filter(row => row.value !== null && row.value !== undefined);
        const layout = this.settings.layout || 'grouped';
        container.css({paddingLeft:layout === 'cards' ? '5px' : 0,paddingRight:layout === 'cards' ? '5px' : 0});
        const selectedIdentity = new Set(this.settings.identity_choices || []);
        const identity = this.identityEntries().filter(entry => selectedIdentity.has(entry.id));
        if (identity.length) {
            container.append($('<div>').addClass('text-muted').css({fontSize:'11px',fontWeight:600,
                textTransform:'uppercase',letterSpacing:'0.06em',margin:'8px 0 5px'}).text(this.tr('hardware')));
            for (const entry of identity) {
                const line = $('<div>').css({display:'flex',flexWrap:'wrap',gap:'4px 12px',padding:'5px 8px',
                    borderBottom:'1px solid rgba(128,128,128,.18)'});
                if (this.settings.show_identity_titles !== '0') line.append($('<span>').text(entry.label).css({flex:'1 1 120px',overflowWrap:'anywhere'}));
                line.append($('<span>').text(entry.value).css({fontWeight:600,overflowWrap:'anywhere',maxWidth:'100%'}));
                container.append(line);
            }
        }
        const separated = layout === 'grouped' || (layout === 'cards' && this.settings.cards_categories === '1');
        const groups = separated ? IPMI_CATEGORIES : ['readings'];
        for (const group of groups) {
            const members = separated ? rows.filter(row => this.category(row) === group) : rows;
            if (!members.length) continue;
            if (separated) container.append($('<div>').addClass('text-muted').css({fontSize: '11px', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 5px'}).text(this.tr('category_' + group.toLowerCase())));
            const section = $('<div>').css(layout === 'cards' ? {display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 90px), 1fr))', gap: '8px', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box'} : {});
            if (layout === 'cards') section.attr('data-ipmimon-grid', '1');
            for (const row of members) {
                const label = String(labels[row.id] || this.defaultLabel(row.name)).slice(0, 80);
                const detail = row.name + ' — ' + this.statusLabel(row.status) + (row.sources ? ' — ' + row.sources : '') + (row.name === 'Fan Mode' ? ' — ' + String(row.value) : '');
                const item = $('<div>').attr('title', detail).css({padding: '6px 8px', boxSizing: 'border-box', width: '100%', textAlign: 'left', borderBottom: '1px solid rgba(128,128,128,.18)',
                    display: 'flex', alignItems: 'baseline', gap: '12px', minWidth: 0});
                const name = $('<span>').text(label).css({textAlign: 'left', overflowWrap: 'anywhere', flex: '1 1 auto'});
                const value = $('<span>').text(this.formatValue(row)).css({textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flex: '0 0 auto', fontWeight: 600, maxWidth: '65%', overflowWrap: 'anywhere'});
                if (row.value === null) value.addClass('text-muted');
                else if (row.status === 'partial') value.addClass('text-warning');
                else if (row.status !== 'ok') value.addClass('text-danger');
                if (layout === 'cards') {
                    item.attr('data-ipmimon-tile', row.id);
                    if (row.name === 'Fan Mode') item.attr('data-ipmimon-mode', '1');
                    item.css({display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '4px',
                        border: '1px solid rgba(128,128,128,.25)', borderRadius: '5px', padding: '9px 10px'});
                    name.css({fontSize: '12px'});
                    value.css({fontSize: '18px', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere'});
                }
                item.append(name, value);
                if (this.settings.show_status === '1') item.append($('<small>').text(this.statusLabel(row.status)).addClass('text-muted').css({textAlign: 'right'}));
                const currentMode = /^0x([0-9a-f]{2})\b/i.exec(String(row.value || ''))?.[1].toLowerCase();
                if (row.name === 'Fan Mode' && this.fanModeChoices().some(choice => choice.code === currentMode)) {
                    if (this.fanModeEditing) {
                        item.css({alignItems:layout === 'cards' ? 'stretch' : 'center',gap:'6px',
                            flexWrap:layout === 'cards' ? 'nowrap' : 'wrap'});
                        name.css({flex:'0 0 auto',maxWidth:'100%',
                            whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});
                        item.empty().append(name, this.fanModePicker(row, layout));
                    }
                    else item.attr({role:'button',tabindex:0}).css({cursor:'pointer'})
                        .on('click keydown', event => {
                            if (event.type === 'keydown' && !['Enter',' '].includes(event.key)) return;
                            event.preventDefault();
                            this.fanModeEditing = true;
                            this.render();
                        });
                }
                section.append(item);
            }
            container.append(section);
        }
        if (!rows.length) container.append($('<div>').addClass('text-muted').text(this.tr('no_selected_or_available_readings')));
        const date = new Date(this.latest.timestamp);
        const stamp = Number.isNaN(date.getTime()) ? this.tr('time_unavailable') : date.toLocaleTimeString();
        container.append($('<div>').addClass('text-muted').css({fontSize: '11px', marginTop: '10px'}).text(
            this.tr('reading') + ' ' + stamp + ' · ' + this.tr('refresh_every') + ' ' + (this.settings.refresh_interval || '10') + ' s'));
        for (const error of this.latest.errors || []) container.append($('<div>').addClass('text-muted').css({fontSize: '11px'}).text(this.backendMessage(error)));
        this.applyTileOccupancy();
    }

    getMarkup() {
        this.contentId = 'ipmimon-content-' + String(this.id);
        return $('<div>').attr('id', this.contentId)
            .css({overflow: 'auto', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box'}).text(this.tr('reading_ipmi'));
    }

    getGridOptions() {
        return {sizeToContent: 850};
    }

    async onMarkupRendered() {
        this.settings = await this.getWidgetConfig();
        if (typeof ResizeObserver !== 'undefined') {
            this.tileObserver?.disconnect();
            this.tileObserver = new ResizeObserver(() => this.applyTileOccupancy());
            const element = document.getElementById(this.contentId);
            if (element) this.tileObserver.observe(element);
        }
        await this.onWidgetTick();
    }

    async onWidgetTick() {
        if (this.busy || this.fanModeUpdating) return;
        const element = document.getElementById(this.contentId);
        if (!element) return;
        if (Date.now() < this.nextReadingAt) return;
        const container = $(element);
        this.busy = true;
        // OPNsense starts its timer once, so skip intermediate ticks for longer intervals.
        this.nextReadingAt = Date.now() + Number(this.settings.refresh_interval || 10) * 1000;
        try {
            const data = await this.ajaxCall('/api/ipmimon/snapshot/get');
            if (!Array.isArray(data.rows) || !Array.isArray(data.errors)) throw new Error('Invalid data');
            this.latest = data;
            if (!this.fanModeEditing) this.render();
        } catch (error) {
            this.latest = null;
            container.text(this.tr('na_reading_failed_access_denied_or_request_timed_out'));
            this.nextReadingAt = Date.now() + 10000;
        } finally {
            this.busy = false;
        }
    }
}
