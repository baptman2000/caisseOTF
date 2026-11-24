# caisseOTF — Balance EXA « Easy Market » connectée à la caisse Ouvretaferme

Ce petit script relie une balance de marché **EXA Easy Market** (fabriquée par Epelsa, sortie RS-232 « protocole $ ») à la **caisse enregistreuse d'Ouvretaferme**. On pose le produit, on touche l'article dans la caisse, et le poids s'inscrit et s'enregistre tout seul.

Il ne modifie pas le site Ouvretaferme, n'utilise pas son API et ne demande aucune clé. Il s'ajoute simplement à la page de la caisse, ouverte dans le navigateur, à l'aide d'un favori (bookmarklet).

> **Projet expérimental, à usage de test uniquement.** Il ne doit pas être utilisé pour de la vente au poids réelle. Le poids transmis à la caisse ne remplace pas une pesée faite et affichée par un instrument de pesage homologué ; la réglementation de la métrologie légale encadre ce type de transmission. Vérifiez toujours le montant avant d'encaisser.

> D'après [balance-connectee-otf](https://github.com/nicolasmieral-wq/balance-connectee-otf) (licence MIT), adapté ici au décodage des trames texte des balances Epelsa/EXA.

## Attention : le navigateur

**Firefox ne peut pas lire de balance Bluetooth**, sur ordinateur comme sur Android : il ne propose pas l'API Web Bluetooth et ne l'aura pas (position de Mozilla). Sur votre tablette Android, ouvrez donc la caisse Ouvretaferme et lancez le script avec **Chrome** (ou Edge ou Samsung Internet — tout navigateur Chromium), **pas avec Firefox**. Rien d'autre ne change : l'appareil reste votre tablette Android.

De même, les favoris « javascript: » ne se lancent pas depuis Firefox mobile mais depuis Chrome sur Android (voir Installation).

## Comment ça marche

```
Balance EXA Easy Market ──RS-232──> adaptateur SH-B30-BLE ──Bluetooth──> Chrome sur Android ──> caisse Ouvretaferme
```

1. La balance, en mode d'envoi automatique, envoie son poids en continu, par exemple `001.245` (0x0D) pour 1,245 kg.
2. Le module SH-B30-BLE transmet ce texte en Bluetooth.
3. Le script est détecté : il lit le poids et l'affiche dans un petit bandeau en haut de la caisse.
4. Quand vous ouvrez un article vendu **au kilo**, il saisit le poids stable dans « Vendu » et touche **Enregistrer** (mode Auto), ou attend que vous touchiez le bouton **Poids** (mode manuel).

### Les sécurités

- **Poids stable uniquement** : trame trop récente ou poids répété insuffisamment, hors limites (`AAAAAAA`), négatif ou zéro : le poids n'est jamais saisi.
- **Mesure récente** : une mesure de plus de 2,5 secondes est refusée, et une déconnexion efface le dernier poids.
- **Correction respectée** : si « Vendu » contient déjà une valeur, le script n'écrit rien.
- **Pas de double pesée** : entre deux articles, le poids doit changer d'au moins 5 g ou repasser par zéro.
- **Articles à la pièce ignorés** : le script n'agit que si l'unité est le kilo.
- **Montant contrôlé** : si la caisse ne calcule pas le montant, le script n'enregistre pas.

## Matériel

- Une balance **EXA Easy Market** (elle possède une sortie RS-232 de série).
- Un adaptateur **DSD TECH SH-B30-BLE** (RS-232 vers Bluetooth Low Energy) et son alimentation 5 V.
- Un câble à fabriquer ou faire fabriquer de la prise série de la balance vers l'adaptateur : broche 3 (Tx+ de la balance) → RxD du module, broche 5 (masse) → GND du module. Le Tx du module peut rester non relié : la balance envoie d'elle-même dans le réglage proposé.
- Une tablette **Android** avec **Chrome**.

## Réglages de la balance (menu 2ᵉ niveau)

D'après le manuel « Easy Market 10 V4 » (chapitre 9.2 et 10) :

| Option | Valeur |
|---|---|
| TYPE TPV | `TYPE 0` |
| TYPE TPV 0 | `TYPE A` |
| MODE D'ENVOI | `AUTOMAT` |
| TRANSMISSION AUTOMATIQUE DU POIDS | `ATTENTE` (trace « attente de demande » : `001.245` + CR) |
| BAUD RATE / PARITÉ / BITS / STOP | `9600` / `NO` / `8` / `1` |

Le script comprend aussi d'autres traces de la même famille si vous choisissez un réglage différent : poids net sous tare (`T001.245`), trace avec STX, trace VECTRON en grammes (`S 000245g`, `SD` = instable, `SI` = hors limites), trace ELZAB étendue avec indicateur de stabilité (`1b E S 001.245`). La stabilité n'étant pas toujours indiquée, elle est déduite de la répétition de trames identiques.

## Installation

### 1. Héberger le script

Le script doit être accessible en ligne, à une adresse en `https://`. Déposez `balance-exa-otf.js` sur votre hébergement, ou servez-vous-en depuis ce dépôt via jsDelivr `https://cdn.jsdelivr.net/gh/baptman2000/caisseOTF@<commit>/balance-exa-otf.js` (remplacez `<commit>` par un numéro de commit précis).

### 2. Créer le favori

Dans Chrome sur un ordinateur, synchronisé avec le même compte que la tablette :

1. Ouvrez le gestionnaire de favoris (Ctrl+Maj+O), ajoutez un favori nommé **Balance EXA**.
2. Champ URL `javascript:void(document.head.appendChild(document.createElement('script')).src='https://VOTRE-SITE/balance-exa-otf.js?v='+Date.now())`

Le `Date.now()` force le chargement de la dernière version à chaque lancement.

### 3. Lancer le script sur la caisse

1. Sur la tablette, dans **Chrome** (pas Firefox), ouvrez une vente dans la caisse Ouvretaferme.
2. Touchez la barre d'adresse, effacez-la, tapez `Balance EXA` et touchez la **suggestion du favori**.
3. Un bandeau apparaît en haut. Touchez **Bluetooth** et choisissez **SH-B30-BLE**.

Il faut relancer le favori à chaque rechargement de la page.

## Utilisation

- **Bandeau du haut** : le poids actuel, le bouton **Bluetooth** (masqué une fois relié), **Auto** et **×** pour retirer le script.
- **Auto (vert)** : posez le produit, touchez l'article, c'est enregistré.
- **Auto (gris)** : mode manuel. Ouvrez l'article et touchez **Poids**, sous « Vendu », puis **Enregistrer**.

## Pour les développeurs

Le script est un seul fichier sans dépendance. Les tests se lancent avec Node.js :

```
node tests/balance-exa.test.js
```

Ils couvrent le décodage des trames (protocole $, VECTRON, ELZAB), les règles de stabilité, l'émulation et la fabrication de trames de test. Le comportement dans la vraie caisse ne peut se vérifier qu'à la main.

Points d'appui dans la page de la caisse, à revoir si Ouvretaferme change son interface :

- champ « Vendu » : `input[name^="number["]` dans `.merchant-field` ;
- montant : `input[name="price[ID]"]` ;
- passage en saisie clavier : `.merchant-switch-keyboard-link`.

## Licence et responsabilité

MIT, comme le projet d'origine. Projet expérimental, sans garantie : l'auteur décline toute responsabilité en cas d'utilisation pour la vente, directe ou non.
