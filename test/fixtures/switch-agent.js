// Fake switch / NAS SNMP agent (tests and demo)
import snmp from 'net-snmp';
const RO = snmp.MaxAccess['read-only'];
const NA = snmp.MaxAccess['not-accessible'];
const I = snmp.ObjectType.Integer, S = snmp.ObjectType.OctetString;

function table(mib, name, oid, indexCols, cols) {
  mib.registerProvider({ name, type: snmp.MibProviderType.Table, oid, maxAccess: NA,
    tableColumns: [...indexCols.map(([number, n]) => ({ number, name: n, type: I, maxAccess: NA })), ...cols.map(([number, n, type]) => ({ number, name: n, type, maxAccess: RO }))],
    tableIndex: indexCols.map(([, n]) => ({ columnName: n })) });
}

export function startAgent(port, address = '127.0.0.1') {
  const agent = snmp.createAgent({ port, address }, () => {});
  agent.getAuthorizer().addCommunity('public');
  const mib = agent.getMib();
  mib.registerProvider({ name: 'sysDescr', type: snmp.MibProviderType.Scalar, oid: '1.3.6.1.2.1.1.1', scalarType: S, maxAccess: RO });
  mib.setScalarValue('sysDescr', 'Fake device');
  return { agent, mib, close: () => agent.close() };
}

/** ports: [{ idx, name, up, speed, alias }], fdb: [{ vlan, mac: 'aa:bb:..', port }] */
export function addSwitch(mib, { ports, fdb }) {
  table(mib, 'ifTable', '1.3.6.1.2.1.2.2.1', [[1, 'ifIndex']], [[2, 'ifDescr', S], [3, 'ifType', I], [7, 'ifAdmin', I], [8, 'ifOper', I]]);
  table(mib, 'ifXTable', '1.3.6.1.2.1.31.1.1.1', [[100, 'ifxIdx']], [[1, 'ifName', S], [15, 'ifHighSpeed', snmp.ObjectType.Gauge], [18, 'ifAlias', S]]);
  table(mib, 'basePort', '1.3.6.1.2.1.17.1.4.1', [[1, 'bpIdx']], [[2, 'bpIf', I]]);
  for (const p of ports) {
    mib.addTableRow('ifTable', [p.idx, `GigabitEthernet ${p.idx}`, 6, 1, p.up ? 1 : 2]);
    mib.addTableRow('ifXTable', [p.idx, p.name, p.speed || 1000, p.alias || '']);
    mib.addTableRow('basePort', [p.idx, p.idx]);
  }
  mib.addTableRow('ifTable', [1000, 'CPU', 24, 1, 1]); // loopback - must be ignored
  table(mib, 'qfdb', '1.3.6.1.2.1.17.7.1.2.2.1', [[101, 'fid'], [102, 'm1'], [103, 'm2'], [104, 'm3'], [105, 'm4'], [106, 'm5'], [107, 'm6']], [[2, 'qPort', I]]);
  for (const f of fdb) mib.addTableRow('qfdb', [f.vlan, ...f.mac.split(':').map((x) => parseInt(x, 16)), f.port]);
}

export function addNas(mib, { volumes, disks, raids, model = 'DS920+', temp = 41, ups = null }) {
  table(mib, 'hrStorage', '1.3.6.1.2.1.25.2.3.1', [[1, 'hsIdx']], [[2, 'hsType', snmp.ObjectType.OID], [3, 'hsDescr', S], [4, 'hsUnit', I], [5, 'hsSize', I], [6, 'hsUsed', I]]);
  volumes.forEach((v, i) => mib.addTableRow('hrStorage', [i + 1, '1.3.6.1.2.1.25.2.1.4', v.name, 4096, v.sizeBlocks, v.usedBlocks]));
  const sc = (name, oid, type, value) => { mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO }); mib.setScalarValue(name, value); };
  sc('synSystem', '1.3.6.1.4.1.6574.1.1', I, 1);
  sc('synTemp', '1.3.6.1.4.1.6574.1.2', I, temp);
  sc('synModel', '1.3.6.1.4.1.6574.1.5.1', S, model);
  sc('synVersion', '1.3.6.1.4.1.6574.1.5.3', S, 'DSM 7.2.2-72806');
  table(mib, 'synDisk', '1.3.6.1.4.1.6574.2.1.1', [[1, 'dIdx']], [[2, 'dId', S], [3, 'dModel', S], [5, 'dStatus', I], [6, 'dTemp', I]]);
  disks.forEach((d, i) => mib.addTableRow('synDisk', [i, d.name, d.model, d.status, d.temp]));
  table(mib, 'synRaid', '1.3.6.1.4.1.6574.3.1.1', [[1, 'rIdx']], [[2, 'rName', S], [3, 'rStatus', I]]);
  raids.forEach((r, i) => mib.addTableRow('synRaid', [i, r.name, r.status]));
  // UPS on the NAS (SYNOLOGY-UPS-MIB)
  if (ups) {
    sc('upsModel', '1.3.6.1.4.1.6574.4.1.1', S, ups.model);
    sc('upsMfr', '1.3.6.1.4.1.6574.4.1.2', S, ups.vendor);
    sc('upsStatus', '1.3.6.1.4.1.6574.4.2.1', S, ups.status);
    sc('upsLoad', '1.3.6.1.4.1.6574.4.2.12.1', I, ups.load);
    sc('upsCharge', '1.3.6.1.4.1.6574.4.3.1.1', I, ups.charge);
    sc('upsRuntime', '1.3.6.1.4.1.6574.4.3.6.1', I, ups.runtime);
  }
}

/** Network card of a UPS: standard UPS-MIB (RFC 1628) or APC PowerNet */
export function addUpsCard(mib, kind) {
  const sc = (name, oid, type, value) => { mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO }); mib.setScalarValue(name, value); };
  if (kind === 'apc') {
    sc('apcModel', '1.3.6.1.4.1.318.1.1.1.1.1.1', S, 'Smart-UPS 1500');
    sc('apcFw', '1.3.6.1.4.1.318.1.1.1.1.2.1', S, 'UPS 09.3');
    sc('apcSerial', '1.3.6.1.4.1.318.1.1.1.1.2.3', S, 'AS1234567890');
    sc('apcBatStatus', '1.3.6.1.4.1.318.1.1.1.2.1.1', I, 2);
    sc('apcCharge', '1.3.6.1.4.1.318.1.1.1.2.2.1', snmp.ObjectType.Gauge32, 100);
    sc('apcRuntime', '1.3.6.1.4.1.318.1.1.1.2.2.3', snmp.ObjectType.TimeTicks, 384000);
    sc('apcReplace', '1.3.6.1.4.1.318.1.1.1.2.2.4', I, 2);
    sc('apcOutput', '1.3.6.1.4.1.318.1.1.1.4.1.1', I, 2);
    sc('apcLoad', '1.3.6.1.4.1.318.1.1.1.4.2.3', snmp.ObjectType.Gauge32, 31);
    return;
  }
  sc('stdMfr', '1.3.6.1.2.1.33.1.1.1', S, 'EATON');
  sc('stdModel', '1.3.6.1.2.1.33.1.1.2', S, '9PX 2200');
  sc('stdFw', '1.3.6.1.2.1.33.1.1.3', S, 'INV: 01.14.0026');
  sc('stdBattery', '1.3.6.1.2.1.33.1.2.1', I, 3);
  sc('stdMinutes', '1.3.6.1.2.1.33.1.2.3', I, 7);
  sc('stdCharge', '1.3.6.1.2.1.33.1.2.4', I, 18);
  sc('stdSource', '1.3.6.1.2.1.33.1.4.1', I, 5);
  table(mib, 'upsOut', '1.3.6.1.2.1.33.1.4.4.1', [[1, 'lineIdx']], [[5, 'pctLoad', I]]);
  mib.addTableRow('upsOut', [1, 42]);
}
