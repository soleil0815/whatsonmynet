// Fake printer SNMP agent (tests and demo)
import snmp from 'net-snmp';
const RO = snmp.MaxAccess['read-only'];
const I = snmp.ObjectType.Integer, S = snmp.ObjectType.OctetString;

export function startPrinterAgent(port, { supplies = [], pages = 12345, errBytes = [0x00, 0x00], status = 3, display = 'Bereit' } = {}) {
  const agent = snmp.createAgent({ port, address: '127.0.0.1' }, () => {});
  agent.getAuthorizer().addCommunity('public');
  const mib = agent.getMib();
  const scalar = (name, oid, type, value) => {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO });
    mib.setScalarValue(name, value);
  };
  scalar('sysDescr', '1.3.6.1.2.1.1.1', S, 'Fake Laser 4000');
  const table = (name, oid, cols) => mib.registerProvider({ name, type: snmp.MibProviderType.Table, oid, maxAccess: snmp.MaxAccess['not-accessible'],
    tableColumns: cols.map(([number, n, type]) => ({ number, name: n, type, maxAccess: RO })),
    tableIndex: [{ columnName: cols[0][1] }, { columnName: cols[1][1] }] });
  table('supplies', '1.3.6.1.2.1.43.11.1.1', [[2, 'sDev', I], [1, 'sIdx', I], [3, 'sCol', I], [4, 'sClass', I], [5, 'sType', I], [6, 'sDescr', S], [8, 'sMax', I], [9, 'sLevel', I]]);
  supplies.forEach((s, i) => mib.addTableRow('supplies', [1, i + 1, s.colorant || 0, s.cls || 3, s.type, s.descr, s.max, s.level]));
  table('colorants', '1.3.6.1.2.1.43.12.1.1', [[2, 'cDev', I], [1, 'cIdx', I], [4, 'cVal', S]]);
  ['black', 'cyan', 'magenta', 'yellow'].forEach((c, i) => mib.addTableRow('colorants', [1, i + 1, c]));
  table('life', '1.3.6.1.2.1.43.10.2.1', [[2, 'lDev', I], [1, 'lIdx', I], [4, 'lCount', snmp.ObjectType.Counter]]);
  mib.addTableRow('life', [1, 1, pages]);
  mib.registerProvider({ name: 'hrPrinter', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.25.3.5.1', maxAccess: snmp.MaxAccess['not-accessible'],
    tableColumns: [{ number: 3, name: 'hIdx', type: I, maxAccess: RO }, { number: 1, name: 'hStatus', type: I, maxAccess: RO }, { number: 2, name: 'hErr', type: S, maxAccess: RO }],
    tableIndex: [{ columnName: 'hIdx' }] });
  mib.addTableRow('hrPrinter', [1, status, Buffer.from(errBytes)]);
  table('display', '1.3.6.1.2.1.43.16.5.1', [[3, 'dDev', I], [1, 'dIdx', I], [2, 'dText', S]]);
  mib.addTableRow('display', [1, 1, display]);
  return { close: () => agent.close(), mib };
}
