import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, dispatch, viewFor, metrics, authLevel } from '../core/session.js';

const run = (s, evs) => evs.reduce(dispatch, s);
const B = { id: 'B', name: 'Lucía G.', hasApp: true };
const AF = { flow: 'amount_first' }; // alternativa descartada: monto primero (estilo Apple)

test('envío feliz: A ingresa monto, B recibe', () => {
  const s = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 5000, t: 0 },
    { type: 'APPROACH', peers: [B], t: 1000 },
    { type: 'PAYER_CONFIRM', auth: 'ok', t: 2500 },
    { type: 'SERVER_RESULT', ok: true, t: 3200 },
  ]);
  assert.equal(s.phase, 'success');
  assert.equal(s.payer, 'A');
  assert.equal(viewFor(s, 'A').screen, 'success');
  assert.equal(viewFor(s, 'B').screen, 'success');
  assert.deepEqual(metrics(s), { steps: 3, elapsedMs: 3200, phase: 'success', failure: null });
});

test('modo inverso: B pide, A es quien paga y autentica', () => {
  let s = run(createSession(AF), [
    { type: 'START', mode: 'request', initiator: 'B', amount: 3000, t: 0 },
    { type: 'APPROACH', peers: [{ id: 'A', name: 'Julián', hasApp: true }], t: 800 },
  ]);
  assert.equal(s.payer, 'A');
  assert.equal(viewFor(s, 'A').screen, 'verify_and_confirm');
  assert.equal(viewFor(s, 'B').screen, 'waiting_for_payer');
  s = run(s, [{ type: 'PAYER_CONFIRM', auth: 'ok', t: 2000 }, { type: 'SERVER_RESULT', ok: true, t: 2600 }]);
  assert.equal(s.phase, 'success');
});

test('fondos insuficientes se detectan antes de pedir autenticación', () => {
  const s = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 999999, t: 0 },
    { type: 'APPROACH', peers: [B], t: 500 },
  ]);
  assert.equal(s.phase, 'failed');
  assert.equal(s.failure, 'insufficient_funds');
});

test('receptor sin app: ofrece invitación, no mueve plata', () => {
  const s = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 1000, t: 0 },
    { type: 'APPROACH', peers: [{ id: 'B', name: 'Marcos', hasApp: false }], t: 500 },
  ]);
  assert.equal(s.phase, 'fallback_invite');
  assert.equal(viewFor(s, 'A').screen, 'invite_without_app');
});

test('varios celulares cerca: hay que elegir, y el elegido se verifica', () => {
  let s = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 1000, t: 0 },
    { type: 'APPROACH', peers: [B, { id: 'C', name: 'Pedro', hasApp: true }], t: 400 },
  ]);
  assert.equal(s.phase, 'ambiguous');
  assert.equal(viewFor(s, 'A').screen, 'choose_person');
  s = dispatch(s, { type: 'SELECT_PEER', id: 'C', t: 1200 });
  assert.equal(s.phase, 'verifying');
  assert.equal(s.payee, 'C');
});

test('corte de conexión: antes de confirmar falla; durante procesamiento queda resultado desconocido y se reconcilia', () => {
  const base = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 1000, t: 0 },
    { type: 'APPROACH', peers: [B], t: 300 },
  ]);
  assert.equal(dispatch(base, { type: 'CONNECTION_LOST', t: 500 }).failure, 'connection_lost');

  let s = run(base, [{ type: 'PAYER_CONFIRM', auth: 'ok', t: 900 }, { type: 'CONNECTION_LOST', t: 1000 }]);
  assert.equal(s.phase, 'unknown_outcome');
  assert.equal(viewFor(s, 'A').screen, 'outcome_pending');
  s = dispatch(s, { type: 'SERVER_RESULT', ok: true, t: 5000 });
  assert.equal(s.phase, 'success');
});

test('alejarse cancela antes de confirmar, pero no durante el procesamiento', () => {
  const verifying = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 1000, t: 0 },
    { type: 'APPROACH', peers: [B], t: 300 },
  ]);
  assert.equal(dispatch(verifying, { type: 'MOVE_AWAY', t: 400 }).phase, 'cancelled');
  const processing = dispatch(verifying, { type: 'PAYER_CONFIRM', auth: 'ok', t: 800 });
  assert.equal(dispatch(processing, { type: 'MOVE_AWAY', t: 900 }).phase, 'processing');
});

test('autenticación escala sobre el umbral y falla si no es ok', () => {
  let s = run(createSession(AF), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 60000, t: 0 },
    { type: 'APPROACH', peers: [B], t: 300 },
  ]);
  assert.equal(authLevel(s), 'step_up');
  assert.equal(viewFor(s, 'A').auth, 'step_up');
  s = dispatch(s, { type: 'PAYER_CONFIRM', auth: 'fail', t: 900 });
  assert.equal(s.failure, 'auth_failed');
});

test('variante Apple (receiverAccepts): suma un paso y el receptor puede rechazar', () => {
  const cfg = { ...AF, receiverAccepts: true };
  const verifying = run(createSession(cfg), [
    { type: 'START', mode: 'send', initiator: 'A', amount: 1000, t: 0 },
    { type: 'APPROACH', peers: [B], t: 300 },
    { type: 'PAYER_CONFIRM', auth: 'ok', t: 900 },
  ]);
  assert.equal(verifying.phase, 'awaiting_accept');
  assert.equal(viewFor(verifying, 'B').screen, 'accept_or_decline');
  const ok = run(verifying, [{ type: 'PAYEE_ACCEPT', t: 1500 }, { type: 'SERVER_RESULT', ok: true, t: 2000 }]);
  assert.equal(metrics(ok).steps, 4);
  assert.equal(dispatch(verifying, { type: 'PAYEE_DECLINE', t: 1500 }).phase, 'cancelled');
});

// ---- Flujo por defecto: receptor > confirmar receptor > monto > Transferir ----
const RF = [
  { type: 'START', mode: 'send', initiator: 'A', t: 0 },
  { type: 'APPROACH', peers: [B], t: 1000 },
];

test('receiver_first feliz: se confirma al receptor, después se ingresa el monto y se transfiere', () => {
  let s = run(createSession(), RF);
  assert.equal(s.phase, 'verifying');
  assert.equal(s.amount, null);
  assert.equal(viewFor(s, 'A').screen, 'confirm_receiver');
  assert.equal(viewFor(s, 'A').counterpart, 'Lucía G.');
  assert.equal(viewFor(s, 'B').screen, 'being_identified');
  s = run(s, [
    { type: 'PEER_CONFIRM', t: 2000 },
    { type: 'SET_AMOUNT', amount: 5000, t: 4000 },
    { type: 'PAYER_CONFIRM', auth: 'ok', t: 5000 },
    { type: 'SERVER_RESULT', ok: true, t: 5600 },
  ]);
  assert.equal(s.phase, 'success');
  assert.deepEqual(metrics(s), { steps: 4, elapsedMs: 5600, phase: 'success', failure: null });
});

test('receiver_first: el saldo insuficiente se muestra en el monto, no corta el flujo', () => {
  let s = run(createSession(), [...RF, { type: 'PEER_CONFIRM', t: 2000 }, { type: 'SET_AMOUNT', amount: 999999, t: 3000 }]);
  assert.equal(s.phase, 'entering_amount');
  assert.equal(viewFor(s, 'A').error, 'insufficient_funds');
  s = dispatch(s, { type: 'SET_AMOUNT', amount: 1000, t: 4000 });
  assert.equal(s.phase, 'ready_to_pay');
  assert.equal(s.amountError, null);
  assert.equal(viewFor(s, 'A').screen, 'review_and_pay');
});

test('receiver_first: alejarse cancela solo antes de confirmar al receptor', () => {
  const verifying = run(createSession(), RF);
  assert.equal(dispatch(verifying, { type: 'MOVE_AWAY', t: 1500 }).phase, 'cancelled');
  const amount = dispatch(verifying, { type: 'PEER_CONFIRM', t: 2000 });
  assert.equal(dispatch(amount, { type: 'MOVE_AWAY', t: 2500 }).phase, 'entering_amount');
});

test('receiver_first: PAYER_CONFIRM sin monto válido no hace nada; se puede corregir el monto', () => {
  let s = run(createSession(), [...RF, { type: 'PEER_CONFIRM', t: 2000 }]);
  assert.equal(dispatch(s, { type: 'PAYER_CONFIRM', auth: 'ok', t: 2500 }).phase, 'entering_amount');
  s = run(s, [{ type: 'SET_AMOUNT', amount: 1000, t: 3000 }, { type: 'EDIT_AMOUNT', t: 3500 }]);
  assert.equal(s.phase, 'entering_amount');
});

test('receiver_first: corte de conexión después de Transferir queda como resultado desconocido', () => {
  const s = run(createSession(), [...RF,
    { type: 'PEER_CONFIRM', t: 2000 }, { type: 'SET_AMOUNT', amount: 1000, t: 3000 },
    { type: 'PAYER_CONFIRM', auth: 'ok', t: 3500 }, { type: 'CONNECTION_LOST', t: 3600 }]);
  assert.equal(s.phase, 'unknown_outcome');
  assert.equal(viewFor(s, 'A').screen, 'outcome_pending');
});

test('receiver_first: receptor sin app va a la invitación, sin pedir monto', () => {
  const s = run(createSession(), [RF[0], { type: 'APPROACH', peers: [{ id: 'B', name: 'Marcos', hasApp: false }], t: 500 }]);
  assert.equal(s.phase, 'fallback_invite');
});

test('el modo inverso (pedir) siempre usa monto primero', () => {
  const s = run(createSession(), [
    { type: 'START', mode: 'request', initiator: 'B', amount: 3000, t: 0 },
    { type: 'APPROACH', peers: [{ id: 'A', name: 'Julián', hasApp: true }], t: 800 },
  ]);
  assert.equal(s.cfg.flow, 'amount_first');
  assert.equal(viewFor(s, 'A').screen, 'verify_and_confirm');
});

test('comparación de pasos: receptor primero cuesta un toque más (confirmar al receptor) que monto primero', () => {
  const rf = run(createSession(), [...RF, { type: 'PEER_CONFIRM', t: 2000 }, { type: 'SET_AMOUNT', amount: 5000, t: 3000 },
    { type: 'PAYER_CONFIRM', auth: 'ok', t: 4000 }, { type: 'SERVER_RESULT', ok: true, t: 4500 }]);
  const af = run(createSession(AF), [{ type: 'START', mode: 'send', initiator: 'A', amount: 5000, t: 0 },
    { type: 'APPROACH', peers: [B], t: 1000 }, { type: 'PAYER_CONFIRM', auth: 'ok', t: 2000 }, { type: 'SERVER_RESULT', ok: true, t: 2500 }]);
  assert.equal(metrics(rf).steps, 4);
  assert.equal(metrics(af).steps, 3);
});
