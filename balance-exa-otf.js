/* Balance EXA Easy Market (famille Epelsa, protocole « $ ») -> caisse Ouvretaferme.
   Basé sur balance-otf.js (projet balance-connectee-otf, licence MIT).
   Le poids s'affiche dans un bandeau et peut compléter le champ « Vendu »
   d'un article vendu au kg. Ne clique jamais sur « Enregistrer » sans le mode Auto.

   Trame principale (TYPE TPV « TYPE 0 » - TYPE A, MODE D'ENVOI « AUTOMAT ») :
     001.245\r        poids en kg, 3 décimales, complété de zéros à gauche
   Autres traces comprises :
     T001.245\r       T = poids net sous tare, F = sous tare fixe
     \x02 001.245\r   trace avec STX
     S 000245g\r\n    trace VECTRON : poids en grammes ; SD = instable ; SI = hors limites
     \x1bES.001.245\r ELZAB étendu : S = stable, U = instable
     AAAAAAA\r        hors de portée / poids négatif
   La stabilité n'est pas toujours envoyée par la balance : elle est déduite
   de la répétition de trames identiques. Mode : window.__BALANCE_MODE = 'sim' ou 'ble'. */
(function (root) {
  'use strict';

  var CONFIG = {
    serviceUuid: null,
    characteristicUuid: null,
    servicesPossibles: [0xffe0, 0xfff0, '6e400001-b5a3-f393-e0a9-e50e24dcca9e', '49535343-fe7d-4ae5-8fa9-9fafd205e455'],
    ageMaxMs: 2500,
    /* Nombre de trames identiques consécutives pour déclarer le poids stable
       quand la balance n'indique pas elle-même la stabilité. */
    tramesStables: 2
  };
  var SEUIL_ZERO = 0.005;
  var SEUIL_ECART = 0.0045;

  /* ---------- Trames texte Epelsa / EXA ---------- */

  function decoderLigne(texte) {
    var s = String(texte);
    var stable = null;

    s = s.replace(/\x02/g, '');
    if (s.charAt(0) === '\x1b') {           /* Protocole ELZAB étendu */
      s = s.slice(1);
      if (s.charAt(0) === 'E') s = s.slice(1);
      if (s.charAt(0) === 'S') { stable = true; s = s.slice(1); }
      else if (s.charAt(0) === 'U') { stable = false; s = s.slice(1); }
    }
    s = s.replace(/^\s+/, '').replace(/\s+$/, '');
    if (!s) return null;

    /* Hors de portée ou poids négatif : la balance remplit la zone de sept « A ». */
    if (/^A+[.A]*$/.test(s.replace(/[TFtf \-]/g, ''))) return { erreur: 'Poids hors limites' };

    /* Trace type VECTRON : « S » = stable, « SD » = instable, « SI » = hors limites,
       poids en grammes. */
    var m = /^S([DI]?)\s*(\d{1,6})\s*g?$/.exec(s);
    if (m) {
      if (m[1] === 'I') return { erreur: 'Poids hors limites' };
      return { kg: parseInt(m[2], 10) / 1000, stable: m[1] !== 'D' };
    }

    m = /^(-)?(?:[TFtf]\s*)?(\d+)(?:\.(\d+))?(kg|g)?$/i.exec(s);
    if (!m) return null;
    if (m[1]) return { erreur: 'Poids négatif' };
    var kg;
    if (m[4] && m[4].toLowerCase() === 'g') kg = parseInt(m[2], 10) / 1000;
    else if (m[3] !== undefined) kg = parseFloat(m[2] + '.' + m[3]);
    else kg = parseInt(m[2], 10) / 1000;
    return { kg: kg, stable: stable };
  }

  function creerLecteur(horloge) {
    var tampon = [], derniere = null, recueA = 0, repetition = 0, precedent = null;
    var horlogeLocale = horloge || Date.now;

    function retenir(mesure) {
      if (mesure.erreur) {
        derniere = mesure; recueA = horlogeLocale();
        precedent = null; repetition = 0;
        return;
      }
      var cle = mesure.kg.toFixed(3);
      repetition = cle === precedent ? repetition + 1 : 1;
      precedent = cle;
      derniere = mesure;
      recueA = horlogeLocale();
    }

    return {
      /* Accepte des morceaux de trame ou plusieurs trames à la fois. */
      recevoir: function (octets) {
        for (var i = 0; i < octets.length; i++) {
          var o = octets[i];
          if (o === 0x0d || o === 0x0a) {
            if (tampon.length) {
              var ligne = '';
              for (var j = 0; j < tampon.length; j++) ligne += String.fromCharCode(tampon[j]);
              tampon = [];
              var m = decoderLigne(ligne);
              if (m) retenir(m);
            }
          } else {
            tampon.push(o);
            if (tampon.length > 32) tampon = [];
          }
        }
      },
      oublier: function () { tampon = []; derniere = null; recueA = 0; repetition = 0; precedent = null; },
      /* Seule la toute dernière trame compte : si elle n'indique pas un poids
         stable et récent, on refuse. */
      mesure: function () {
        if (!derniere) return { ok: false, raison: 'Aucune mesure reçue' };
        if (horlogeLocale() - recueA > CONFIG.ageMaxMs) return { ok: false, raison: 'Mesure trop ancienne' };
        if (derniere.erreur) return { ok: false, raison: derniere.erreur, kg: derniere.kg };
        if (derniere.kg < 0) return { ok: false, raison: 'Poids négatif', kg: derniere.kg };
        if (derniere.kg === 0) return { ok: false, raison: 'Aucun poids', kg: 0 };
        if (derniere.stable === false) return { ok: false, raison: 'Poids en mouvement', kg: derniere.kg };
        if (derniere.stable === null && repetition < CONFIG.tramesStables) return { ok: false, raison: 'Poids en mouvement', kg: derniere.kg };
        return { ok: true, kg: derniere.kg, valeur: derniere.kg.toFixed(3) };
      }
    };
  }

  /* ---------- Émulation de la balance (mode « sim ») ---------- */

  function fabriquerTrame(kg, etat) {
    var a = '';
    var v = Math.abs(kg).toFixed(3);
    while (v.length < 7) v = '0' + v;
    if (etat === 'hors') a = 'AAAAAAA\r';
    else if (etat === false) a = '\x1bEU' + v + '\r';
    else if (etat === true) a = '\x1bES' + v + '\r';
    else a = (kg < 0 ? '-' : '') + v + '\r';
    var o = [];
    for (var i = 0; i < a.length; i++) o.push(a.charCodeAt(i));
    return o;
  }

  /* ---------- Bluetooth ---------- */
  var FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';

  function surIos() {
    return /iPad|iPhone|Bluefy/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
  }

  /* La caisse ajoute des fonctions énumérables à Array et String, ce qui peut perturber Bluefy. */
  function masquerAjoutsPrototypes() {
    [Object.prototype, Array.prototype, String.prototype].forEach(function (p) {
      Object.keys(p).forEach(function (k) { Object.defineProperty(p, k, { enumerable: false }); });
    });
  }

  /* Bluefy rejette certaines recherches avec un simple code : on essaie les formes possibles. */
  async function chercherIos(bluetooth) {
    masquerAjoutsPrototypes();
    var essais = [
      { filters: [{ namePrefix: 'SH-B30' }], optionalServices: [FFE0] },
      { acceptAllDevices: true, optionalServices: [FFE0] },
      { filters: [{ services: [FFE0] }] },
      { acceptAllDevices: true }
    ], erreurs = [];
    for (var i = 0; i < essais.length; i++) {
      try {
        return await bluetooth.requestDevice(essais[i]);
      } catch (e) {
        if (e && e.name === 'NotFoundError') throw e;
        erreurs.push((i + 1) + '=' + (e && e.message ? e.message : String(e)));
      }
    }
    throw new Error('Essais ' + erreurs.join(', '));
  }

  async function connecterBle(bluetooth, lecteur, signaler, ios) {
    if (!bluetooth) throw new Error('Bluetooth indisponible dans ce navigateur (Firefox ne le propose pas : utilisez Chrome)');
    var liste = CONFIG.serviceUuid ? [CONFIG.serviceUuid] : CONFIG.servicesPossibles;
    var appareil = ios ? await chercherIos(bluetooth) : await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: liste });
    appareil.addEventListener('gattserverdisconnected', function () {
      lecteur.oublier();
      signaler('Balance déconnectée');
    });
    var serveur = await appareil.gatt.connect();
    var uuidService = ios ? FFE0 : CONFIG.serviceUuid;
    var services = uuidService ? [await serveur.getPrimaryService(uuidService)] : await serveur.getPrimaryServices();
    for (var s = 0; s < services.length; s++) {
      var carac = await services[s].getCharacteristics();
      for (var c = 0; c < carac.length; c++) {
        var ch = carac[c];
        if (CONFIG.characteristicUuid ? ch.uuid !== CONFIG.characteristicUuid : !ch.properties.notify) continue;
        ch.addEventListener('characteristicvaluechanged', function (e) {
          var v = e.target.value;
          lecteur.recevoir(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        });
        await ch.startNotifications();
        return { service: services[s].uuid, caracteristique: ch.uuid, deconnecter: function () { appareil.gatt.disconnect(); } };
      }
    }
    appareil.gatt.disconnect();
    throw new Error('Aucune caractéristique de notification trouvée');
  }

  /* ---------- USB : câble CP2102 (9600 8N1) ---------- */
  var USB_CP210X = { vendorId: 0x10c4, productId: 0xea60 };

  async function reglerCp210x(usb, numero) {
    function cmd(request, value, data) {
      return usb.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: request, value: value, index: numero }, data);
    }
    await cmd(0x00, 0x0001);          /* active l'interface */
    await cmd(0x03, 0x0800);          /* 8 bits, sans parité, 1 bit d'arrêt */
    await cmd(0x1e, 0, new Uint8Array([0x80, 0x25, 0x00, 0x00]));   /* 9600 bauds */
    await cmd(0x07, 0x0303);          /* DTR et RTS actifs */
  }

  async function ouvrirUsb(usb, appareil, lecteur, signaler) {
    await appareil.open();
    if (!appareil.configuration) await appareil.selectConfiguration(1);
    var interf = appareil.configuration.interfaces[0], numero = interf.interfaceNumber;
    try {
      await appareil.claimInterface(numero);
    } catch (e) {
      throw new Error('Câble réservé par Android : USB direct impossible');
    }
    var entree = interf.alternate.endpoints.filter(function (p) { return p.direction === 'in' && p.type === 'bulk'; })[0];
    if (!entree) throw new Error('Câble USB non reconnu');
    await reglerCp210x(appareil, numero);
    var actif = true;
    function fin(message) {
      if (!actif) return;
      actif = false;
      lecteur.oublier();
      usb.removeEventListener('disconnect', surRetrait);
      signaler(message);
    }
    function surRetrait(e) { if (e.device === appareil) fin('Câble USB débranché'); }
    usb.addEventListener('disconnect', surRetrait);
    (async function () {
      try {
        while (actif) {
          var r = await appareil.transferIn(entree.endpointNumber, 64);
          if (r.status !== 'ok') throw new Error(r.status);
          if (r.data && r.data.byteLength) lecteur.recevoir(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        }
      } catch (e) {
        fin('Liaison USB perdue');
      }
    })();
    return { deconnecter: function () { actif = false; lecteur.oublier(); usb.removeEventListener('disconnect', surRetrait); appareil.close().catch(function () {}); } };
  }

  async function connecterUsb(usb, lecteur, signaler) {
    if (!usb) throw new Error('USB indisponible dans ce navigateur');
    var appareil = await usb.requestDevice({ filters: [USB_CP210X] });
    return ouvrirUsb(usb, appareil, lecteur, signaler);
  }

  /* Reprend le câble déjà autorisé, pour éviter de le rechoisir à chaque lancement. */
  async function reconnecterUsb(usb, lecteur, signaler) {
    if (!usb || !usb.getDevices) return null;
    var liste = (await usb.getDevices()).filter(function (d) { return d.vendorId === USB_CP210X.vendorId && d.productId === USB_CP210X.productId; });
    return liste.length === 1 ? ouvrirUsb(usb, liste[0], lecteur, signaler) : null;
  }

  /* ---------- Caisse ---------- */
  function visibles(doc) {
    return Array.prototype.filter.call(doc.querySelectorAll('input[name^="number["]'), function (e) { return (e.closest('.merchant-field') || e).offsetParent !== null; });
  }

  /* Le texte propre d'un élément, sans celui du bouton ajouté dedans. */
  function texteDe(k) {
    return Array.prototype.map.call(k.childNodes, function (n) { return n.nodeType === 3 ? n.nodeValue : (n.hasAttribute && n.hasAttribute('data-balance') ? '' : n.textContent); }).join('').trim();
  }

  function trouverChamp(doc) {
    var champs = visibles(doc);
    if (champs.length !== 1) return null;
    var bloc = champs[0];
    for (var n = 0; n < 5 && bloc.parentElement; n++) {
      bloc = bloc.parentElement;
      var feuilles = Array.prototype.filter.call(bloc.querySelectorAll('*'), function (k) {
        if (k.hasAttribute('data-balance')) return false;
        var seulBouton = k.children.length === 1 && k.children[0].hasAttribute('data-balance');
        return (!k.children.length || seulBouton) && texteDe(k);
      });
      var textes = feuilles.map(texteDe);
      var i = textes.indexOf('Vendu');
      if (i < 0) continue;
      var fin = textes.findIndex(function (t, x) { return x > i && t.indexOf('€') >= 0; });
      var unites = textes.slice(i + 1, fin < 0 ? undefined : fin);
      return { champ: champs[0], etiquette: feuilles[i], auKilo: unites.indexOf('kg') >= 0 };
    }
    return null;
  }

  function ecrire(champ, valeur) {
    /* Le pavé tactile de la caisse limite à 2 décimales et ne recalcule pas le montant :
       on passe l'article en saisie clavier, comme avec l'icône clavier. */
    var article = champ.closest('.merchant'), lien = article && article.querySelector('.merchant-switch-keyboard-link');
    if (lien && article.classList.contains('merchant-switch-touch')) lien.click();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(champ, valeur);
    champ.dispatchEvent(new Event('input', { bubbles: true }));
    /* Sur écran tactile, la caisse masque le champ et affiche sa valeur dans ce bloc. */
    var zone = champ.closest('.merchant-field'), affichage = zone && zone.querySelector('.merchant-value');
    if (affichage) affichage.textContent = valeur.replace('.', ',');
    champ.blur();
  }

  function fr(kg) { return kg.toFixed(3).replace('.', ',') + ' kg'; }

  function creerElement(tag, style, texte) {
    var e = document.createElement(tag);
    e.style.cssText = style;
    if (texte) e.textContent = texte;
    return e;
  }

  function demarrer() {
    if (root.__balanceExaOtf) root.__balanceExaOtf.arreter();
    var mode = root.__BALANCE_MODE === 'sim' ? 'sim' : 'ble';
    var lecteur = creerLecteur(), liaison = null, sim = null, note = '', noteJusque = 0;

    /* Petit bandeau dans l'en-tête sombre de la caisse, entre le titre et les menus. */
    var barre = creerElement('div', 'position:fixed;top:12px;z-index:2147483000;background:#222;color:#fff;font:600 15px system-ui,sans-serif;padding:5px 4px 5px 10px;border-radius:8px;display:flex;align-items:center;gap:6px;max-width:calc(100vw - 184px);box-sizing:border-box;box-shadow:0 0 0 1px rgba(255,255,255,.25)');
    var etat = creerElement('div', 'line-height:1.15;min-width:0');
    var commandes = creerElement('div', 'display:flex;gap:2px;align-items:center;flex:none');
    var styleBtn = 'border:0;border-radius:6px;padding:4px 7px;font:600 12px system-ui,sans-serif;background:#fff;color:#222;cursor:pointer';
    var btnBle = null, panneauSim = null;
    /* Mode automatique : entre deux pesées, le poids doit changer ou repasser par zéro. */
    var auto = true, zeroVu = true, dernierKg = null, ouvert = null;
    try { auto = localStorage.getItem('balance-exa-otf-auto') !== '0'; } catch (e) {}
    barre.appendChild(etat); barre.appendChild(commandes);
    document.body.appendChild(barre);

    function montantDe(champ) {
      var p = champ.form && champ.form.querySelector('input[name="price[' + champ.name.replace(/\D/g, '') + ']"]');
      return p ? parseFloat(p.value) : NaN;
    }

    function boutonEnregistrer(champ) {
      var b = champ.form ? Array.prototype.filter.call(champ.form.querySelectorAll('button'), function (x) { return x.textContent.trim() === 'Enregistrer'; }) : [];
      return b.length === 1 ? b[0] : null;
    }

    /* Appelé à chaque rafraîchissement : décide une seule fois par ouverture d'article. */
    function automatisme(cible, m) {
      if (m.ok && (m.kg < SEUIL_ZERO || (dernierKg !== null && Math.abs(m.kg - dernierKg) >= SEUIL_ECART))) zeroVu = true;
      if (!cible || !cible.auKilo) { ouvert = null; return; }
      if (ouvert !== cible.champ) {
        ouvert = cible.champ;
        ouvert.__balanceFait = cible.champ.value !== '';
        if (ouvert.__balanceFait && auto) noter('Correction : poids conservé');
      }
      if (!auto || ouvert.__balanceFait || cible.champ.value !== '') return;
      if (!m.ok || m.kg < SEUIL_ZERO) return;
      if (!zeroVu) return noter('Même poids : changez le produit');
      ouvert.__balanceFait = true;
      var champ = cible.champ, enreg = boutonEnregistrer(champ), poids = m.kg;
      if (!enreg) return noter('Enregistrez à la main');
      ecrire(champ, m.valeur);
      setTimeout(function () {
        if (!(montantDe(champ) > 0)) return noter('Montant non calculé : à vérifier');
        zeroVu = false;
        dernierKg = poids;
        enreg.click();
      }, 150);
    }

    function noter(t) { note = t; noteJusque = Date.now() + 4000; }

    function dire(t, duree) { note = t; noteJusque = Date.now() + (duree || 4000); rafraichir(); }

    if (mode === 'ble') {
      var relier = function (promesse) {
        promesse.then(function (l) {
          if (!l) return;
          if (liaison) liaison.deconnecter();
          liaison = l;
          dire('Connectée');
        }).catch(function (e) { dire('Erreur ' + (e && e.name ? e.name + ' : ' : '') + (e && e.message ? e.message : String(e)), 30000); });
      };
      var perdu = function (t) { liaison = null; dire(t); };
      btnBle = creerElement('button', styleBtn, 'Bluetooth');
      if (surIos()) {
        /* Comme la page d'exemple qui marche dans Bluefy : formulaire et appel immédiat au toucher. */
        var formBle = document.createElement('form');
        formBle.style.display = 'contents';
        btnBle.type = 'submit';
        formBle.onsubmit = function (ev) {
          ev.preventDefault();
          masquerAjoutsPrototypes();
          var demande = navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [FFE0] });
          relier(connecterBle({ requestDevice: function () { return demande; } }, lecteur, perdu, true));
        };
        formBle.appendChild(btnBle);
        commandes.appendChild(formBle);
      } else {
        btnBle.type = 'button';
        btnBle.onclick = function () { dire('Recherche du module…'); relier(connecterBle(navigator.bluetooth, lecteur, perdu, false)); };
        commandes.appendChild(btnBle);
      }
    } else {
      sim = { kg: 0.245, stable: true, hors: false, coupe: false };
      panneauSim = creerElement('div', 'position:fixed;right:12px;bottom:12px;z-index:2147483000;background:#222;color:#fff;font:14px system-ui,sans-serif;padding:8px;border-radius:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center');
      document.body.appendChild(panneauSim);
      var saisie = creerElement('input', 'width:80px;padding:7px;border:0;border-radius:6px;font:14px system-ui');
      saisie.type = 'number'; saisie.step = '0.001'; saisie.value = '0.245';
      saisie.oninput = function () { var v = parseFloat(saisie.value); sim.kg = isNaN(v) ? 0 : v; };
      panneauSim.appendChild(saisie);
      lSim('Stable', function (c) { sim.stable = c; });
      lSim('Hors limites', function (c) { sim.hors = c; if (c) lecteur.oublier(); });
      lSim('Coupée', function (c) { sim.coupe = c; if (c) lecteur.oublier(); });
      function lSim(label, appliquer) {
        var l = creerElement('label', 'font-size:13px;display:flex;align-items:center;gap:3px');
        var c = document.createElement('input');
        c.type = 'checkbox';
        c.onchange = function () { appliquer(c.checked); };
        l.appendChild(c); l.appendChild(document.createTextNode(label));
        panneauSim.appendChild(l);
      }
      /* Envoie la trame en deux morceaux, comme une notification Bluetooth peut le faire. */
      var tic = function () {
        if (sim.coupe) return;
        var o = fabriquerTrame(sim.hors ? 0 : sim.kg, sim.hors ? 'hors' : sim.stable);
        var mil = 1 + Math.floor(Math.random() * (o.length - 1));
        lecteur.recevoir(o.slice(0, mil)); lecteur.recevoir(o.slice(mil));
      };
      tic();
      sim.minuteur = setInterval(tic, 600);
    }

    var btnAuto = creerElement('button', styleBtn, 'Auto');
    btnAuto.type = 'button';
    btnAuto.onclick = function () {
      auto = !auto;
      try { localStorage.setItem('balance-exa-otf-auto', auto ? '1' : '0'); } catch (e) {}
      rafraichir();
    };
    commandes.appendChild(btnAuto);

    var btnFin = creerElement('button', 'border:0;background:none;color:#fff;font:700 18px/1 system-ui,sans-serif;padding:2px 6px;cursor:pointer', '×');
    btnFin.setAttribute('aria-label', 'Retirer');
    btnFin.type = 'button';
    btnFin.onclick = function () { root.__balanceExaOtf.arreter(); };
    commandes.appendChild(btnFin);

    /* Placé DANS l'étiquette « Vendu » pour ne pas décaler la grille de la fenêtre. */
    var bouton = creerElement('div', 'display:block;width:max-content;margin-top:4px;border:0;border-radius:7px;padding:6px 10px;font:600 14px system-ui,sans-serif;background:#2e7d32;color:#fff;cursor:pointer;line-height:1.2');
    bouton.setAttribute('role', 'button');
    bouton.setAttribute('data-balance', '1');
    bouton.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var cible = trouverChamp(document), m = lecteur.mesure();
      if (!cible || !cible.auKilo) return dire('Champ ambigu : rien modifié');
      if (!m.ok) return dire(m.raison + ' : rien modifié');
      ecrire(cible.champ, m.valeur);
    });

    function rafraichir() {
      var m = lecteur.mesure();
      etat.textContent = Date.now() < noteJusque ? note : (m.ok ? fr(m.kg) : m.raison);
      etat.style.fontSize = (m.ok && Date.now() >= noteJusque) ? '17px' : '12px';
      barre.style.right = (window.innerWidth < 700 ? 88 : 450) + 'px';
      if (btnBle) btnBle.style.display = liaison ? 'none' : '';
      bouton.textContent = 'Poids';
      bouton.style.background = m.ok ? '#2e7d32' : '#888';
      btnAuto.style.background = auto ? '#2e7d32' : '#777';
      btnAuto.style.color = '#fff';
      var cible = trouverChamp(document);
      automatisme(cible, m);
      if (cible && cible.auKilo) {
        if (bouton.parentNode !== cible.etiquette) cible.etiquette.appendChild(bouton);
      } else if (bouton.parentNode) {
        bouton.parentNode.removeChild(bouton);
      }
    }

    var minuteurUi = setInterval(rafraichir, 250);
    rafraichir();
    root.__balanceExaOtf = { sim: sim,
      arreter: function () {
        clearInterval(minuteurUi);
        if (sim) clearInterval(sim.minuteur);
        if (liaison) liaison.deconnecter();
        if (bouton.parentNode) bouton.parentNode.removeChild(bouton);
        barre.parentNode.removeChild(barre);
        if (panneauSim) panneauSim.parentNode.removeChild(panneauSim);
        root.__balanceExaOtf = null;
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { decoderLigne: decoderLigne, creerLecteur: creerLecteur, fabriquerTrame: fabriquerTrame, connecterBle: connecterBle, connecterUsb: connecterUsb, reconnecterUsb: reconnecterUsb, CONFIG: CONFIG };
  } else {
    demarrer();
  }
})(typeof window !== 'undefined' ? window : globalThis);
