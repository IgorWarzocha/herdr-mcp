import { BridgeError } from './errors.mjs';

// Names are selectors, never durable addresses. Keep the exact Core ID grammar.
export const CORE_ID = /^t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;
export const CORE_ADDRESS = /^(?:[a-f0-9]{32}\/)?t[1-9][0-9bcdfghjkmnpqrstvwxyz]*$/;
const MACHINE_ID = /^[a-f0-9]{32}$/;
export const LOCAL_MACHINE = { id: 'local', name: 'local', state: 'connected' };

export function machineCatalogue(rows = []) {
  if (!Array.isArray(rows)) throw new BridgeError('bridge_error');
  const ids = new Set();
  return rows.map(row => {
    if (!row || !MACHINE_ID.test(row.id) || typeof row.name !== 'string' || !row.name ||
        typeof row.state !== 'string' || !row.state || ids.has(row.id)) throw new BridgeError('bridge_error');
    ids.add(row.id);
    return { id: row.id, name: row.name, state: row.state };
  });
}

export function selectMachine(machines, selector) {
  if (selector === 'local') return LOCAL_MACHINE;
  const matches = machines.filter(machine => machine.id === selector || machine.name === selector);
  if (!matches.length) throw new BridgeError('invalid_arguments', 'Unknown machine. Read list and choose a current machine name or ID.');
  if (matches.length > 1) throw new BridgeError('ambiguous_target', 'Choose the machine ID from list.');
  return matches[0];
}

export function requireConnected(machine) {
  if (machine.state !== 'connected') throw new BridgeError('runtime_unavailable',
    'The selected machine is not connected. Check its state in list and reconnect it through Core. No action was routed locally.');
}

export function corePane(address, machines = []) {
  if (typeof address !== 'string') throw new BridgeError('bridge_error');
  const parts = address.split('/');
  const localId = parts.at(-1);
  if (parts.length > 2 || !CORE_ID.test(localId)) throw new BridgeError('bridge_error');
  const machine = parts.length === 1 ? LOCAL_MACHINE : selectMachine(machines, parts[0]);
  const canonical = machine.id === 'local' ? localId : `${machine.id}/${localId}`;
  return { runtime: 'core', pane_id: `core:${canonical}`, local_id: localId,
    address: canonical, machine_id: machine.id, machine_name: machine.name };
}
