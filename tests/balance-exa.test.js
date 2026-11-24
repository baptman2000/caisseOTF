/* Tests du décodeur de trames : node tests/balance-exa.test.js */
'use strict';

var assert = require('assert');
var script = require('../balance-exa-otf.js');
var decoderLigne = script.decoderLigne;
var creerLecteur = script.creerLecteur;
var fabriquerTrame = script.fabriquerTrame;

/* ---------- decoderLigne ---------- */

/* Trame principale : poids en kg, 3 décimales, zéros à gauche. */
assert.deepStrictEqual(decoderLigne('001.245\r'), { kg: 1.245, stable: null });
assert.deepStrictEqual(decoderLigne('000.000\r'), { kg: 0, stable: null });
assert.deepStrictEqual(decoderLigne('014.995\r'), { kg: 14.995, stable: null });
/* Poids net sous tare. */
assert.deepStrictEqual(decoderLigne('T000.245\r'), { kg: 0.245, stable: null });
assert.deepStrictEqual(decoderLigne('F000.245\r'), { kg: 0.245, stable: null });
/* Trace avec STX et état de tare en premier caractère. */
assert.deepStrictEqual(decoderLigne('\x02 001.010\r'), { kg: 1.01, stable: null });
assert.deepStrictEqual(decoderLigne('\x02T001.010\r'), { kg: 1.01, stable: null });
/* Trace type VECTRON : grammes, S = stable, SD = instable, SI/7 'A' = hors limites. */
assert.deepStrictEqual(decoderLigne('S  000245g\r\n').kg, 0.245);
assert.strictEqual(decoderLigne('S  000245g\r\n').stable, true);
assert.strictEqual(decoderLigne('SD 000245g\r\n').stable, false);
assert.deepStrictEqual(decoderLigne('SI 000245g\r\n'), { erreur: 'Poids hors limites' });
assert.deepStrictEqual(decoderLigne('AAAAAAA\r'), { erreur: 'Poids hors limites' });
assert.deepStrictEqual(decoderLigne('-000.245\r'), { erreur: 'Poids négatif' });
/* ELZAB étendu : stabilité envoyée par la balance. */
assert.deepStrictEqual(decoderLigne('\x1bES 001.245\r'), { kg: 1.245, stable: true });
assert.deepStrictEqual(decoderLigne('\x1bEU 001.245\r'), { kg: 1.245, stable: false });
/* Lignes parasites ignorées. */
assert.strictEqual(decoderLigne(''), null);
assert.strictEqual(decoderLigne('coucou\r'), null);
assert.strictEqual(decoderLigne('001.245x\r'), null);

/* ---------- creerLecteur ---------- */

var maintenant = 1000;
function horloge() { return maintenant; }

function recevoir(lecteur, texte) {
  lecteur.recevoir(texte.split('').map(function (c) { return c.charCodeAt(0); }));
}

var lecteur = creerLecteur(horloge);
assert.strictEqual(lecteur.mesure().ok, false);
assert.strictEqual(lecteur.mesure().raison, 'Aucune mesure reçue');

/* Une seule trame : poids pas encore déclaré stable. */
recevoir(lecteur, '000.245\r');
var m = lecteur.mesure();
assert.strictEqual(m.ok, false);
assert.strictEqual(m.raison, 'Poids en mouvement');

/* Deux trames identiques de suite : poids stable et récent. */
maintenant = 1100;
recevoir(lecteur, '000.245\r');
m = lecteur.mesure();
assert.strictEqual(m.ok, true);
assert.strictEqual(m.kg, 0.245);
assert.strictEqual(m.valeur, '0.245');

/* Trop ancienne/mesure figée : la liaison coupe, on refuse. */
maintenant = 1100 + 3000;
m = lecteur.mesure();
assert.strictEqual(m.ok, false);
assert.strictEqual(m.raison, 'Mesure trop ancienne');
lecteur.oublier();
assert.strictEqual(lecteur.mesure().raison, 'Aucune mesure reçue');

/* Poids poids instable annoncé par la balance : constamment refusé. */
maintenant = 2000;
recevoir(lecteur, '\x1bEU 002.000\r');
maintenant = 2050;
assert.strictEqual(lecteur.mesure().raison, 'Poids en mouvement');
/* Puis la balance lève son indicateur de stabilité. */
maintenant = 2100;
recevoir(lecteur, '\x1bES 002.000\r');
assert.strictEqual(lecteur.mesure().ok, true);

/* Hors limites et zéro sont refusés. */
var ledger2 = creerLecteur(horloge);
recevoir(ledger2, 'AAAAAAA\r');
assert.strictEqual(ledger2.mesure().raison, 'Poids hors limites');
ledger2.oublier();
recevoir(ledger2, '000.000\r');
recevoir(ledger2, '000.000\r');
assert.strictEqual(ledger2.mesure().raison, 'Aucun poids');

/* Trame coupée en deux morceaux, comme une notification Bluetooth. */
var ledger3 = creerLecteur(horloge);
var t1 = fabriquerTrame(0.35, true);
ledger3.recevoir(t1.slice(0, 4));
ledger3.recevoir(t1.slice(4));
var t2 = fabriquerTrame(0.35, true);
ledger3.recevoir(t2.slice(0, 4));
ledger3.recevoir(t2.slice(4));
assert.strictEqual(ledger3.mesure().kg, 0.35);

/* Fabriquer une trame 'hors' de limites. */
assert.strictEqual(fabriquerTrame(0, 'hors').join(','), [65, 65, 65, 65, 65, 65, 65, 13].join(','));

console.log('OK - tous les tests passent');
