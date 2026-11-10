# Dépôt signé et installation depuis le gestionnaire

## 1. Informations à fixer avant publication

- URL Git et adresse réelle du mainteneur.
- Licence et texte LICENSE correspondants, choisis par le propriétaire du dépôt.
- Version/architecture OPNsense prises en charge et validées.
- Hébergement HTTPS du catalogue et des .pkg (une URL de base par branche/ABI).
- Clé privée de signature conservée hors du dépôt Git et des répertoires publiés.

Les exemples ci-dessous sont à adapter, pas des services déjà créés. Le projet
n'a pas été publié ni envoyé à un hébergeur et aucune clé n'a été générée ici.

## 2. Générer une paire de clés dédiée

Sur une machine de signature de confiance, dans un répertoire hors du projet :

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ipmi-monitor.key
openssl pkey -in ipmi-monitor.key -pubout -out ipmi-monitor.pub
```

Conserver la clé privée en 0600 et en faire une sauvegarde sécurisée. Seule la
clé publique doit être distribuée. Le script refuse une clé privée accessible
au groupe/aux autres, des clés non correspondantes, ou une clé placée dans les
répertoires de sortie publiables. Il n'affiche jamais le contenu de la clé privée.

## 3. Construire et signer le catalogue

Après construction native et tests du .pkg, depuis la racine du projet :

```sh
python3 -B scripts/publish_repository.py \
  --packages dist/packages \
  --output dist/repository \
  --client-output dist/client \
  --private-key /secure/ipmi-monitor.key \
  --public-key /secure/ipmi-monitor.pub \
  --url https://packages.example.invalid/ipmi-monitor/opnsense/26.7/amd64
```

Le script refuse les répertoires de sortie déjà existants. Pour une nouvelle
publication, utiliser de nouveaux chemins. Le script vérifie que tous les
paquets d'entrée portent le nom os-ipmi-monitor, puis utilise la signature
native de `pkg repo` avec une clé RSA. Il produit :

- `dist/repository/` : .pkg et métadonnées signées générées par la version locale
  de pkg, ainsi que la clé publique ; **tout ce dossier** est à héberger à l'URL.
- `dist/client/ipmi-monitor.conf` : définition du dépôt avec signature_type pubkey.
- `dist/client/ipmi-monitor.pub` et PUBLIC-KEY-SHA256.txt : clé à vérifier avant confiance.

Le script ne fait aucun upload. Un GitHub Release seul contenant le .pkg ne
remplace pas un catalogue pkg : il faut que tous les fichiers de repository/
soient accessibles sous une URL de base cohérente. Ne pas servir de répertoire
contenant des clés privées. Publier les métadonnées et les paquets ensemble, en
remplaçant atomiquement la version du dépôt lorsque c'est possible.

## 4. Activer le dépôt sur une instance de test

Vérifier hors bande l'empreinte SHA-256 de la clé publique. La télécharger depuis
la même URL et lui faire confiance sans comparaison indépendante ne fournit pas
ce contrôle initial. Copier ensuite les fichiers publics vérifiés sur la cible :

```sh
install -d -o root -g wheel -m 755 /usr/local/etc/pkg/keys
install -o root -g wheel -m 644 ipmi-monitor.pub /usr/local/etc/pkg/keys/ipmi-monitor.pub
install -o root -g wheel -m 644 ipmi-monitor.conf /usr/local/etc/pkg/repos/ipmi-monitor.conf
pkg update -r ipmi-monitor
pkg search -r ipmi-monitor os-ipmi-monitor
```

Ces commandes sont des modifications administratives à exécuter volontairement
en laboratoire. Aucun script fourni ne modifie silencieusement la confiance des
dépôts du firewall. Ne pas remplacer ni désactiver le dépôt OPNsense officiel ;
ce dépôt complémentaire ne doit publier que os-ipmi-monitor.

Le paquet doit alors être proposé dans System / Firmware / Plugins (ou Packages,
selon les filtres/version). Actualiser les informations de firmware si la liste
reste ancienne. Relever le comportement exact dans la version cible avant de
documenter ce chemin comme validé. L'installation automatique depuis l'interface
reste à tester : ce n'est pas une intégration au dépôt officiel OPNsense.

Sur l'installation autonome existante, faire la migration legacy.py **avant**
de lancer la première installation depuis l'interface. Une mise à jour ultérieure
du même paquet ne nécessite plus cette migration.

## 5. Tests d'acceptation avant diffusion

1. Construire sur l'ABI et la branche cibles, inspecter `pkg info -F paquet.pkg`.
2. Vérifier l'archive et les scripts : six fichiers applicatifs + métadonnées de
   version natives, aucun secret, aucun appel IPMI dans les hooks.
3. Installer à neuf sur une VM de test, puis sur le matériel IPMI de laboratoire.
4. Vérifier authentification, ACL, capteurs, actualisation, options, groupes et langue.
5. Tester la migration des six fichiers autonomes, leurs sauvegardes et le refus
   d'une collision avec un paquet étranger.
6. Construire une version supérieure et vérifier mise à jour via le dépôt signé
   sans perte de préférences. Ne jamais republier une même version avec d'autres octets.
7. Vérifier qu'un catalogue modifié ou une clé incorrecte entraîne un refus.
8. Retirer le paquet, vérifier son inventaire et les hooks ; restaurer l'installation
   autonome depuis la sauvegarde si nécessaire.
9. Publier les résultats précis et les seules versions réellement testées.

Le script de publication n'effectue pas ces tests d'intégration à votre place.
