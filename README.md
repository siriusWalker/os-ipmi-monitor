# IPMI Monitor

Widget de monitoring matériel IPMI en lecture seule pour OPNsense : températures,
ventilateurs, tensions, états SDR, mode ventilateur et PWM Supermicro. Sélection
des capteurs, libellés personnalisés, groupes dynamiques et interface français/anglais.

**Nom du dépôt : `ipmi-monitor`. Nom du paquet/plugin OPNsense : `os-ipmi-monitor`.**
La première version du paquet est 1.0.0. Les sources de travail ont évolué
depuis la version autonome, notamment pour les identifiants internes des catégories.
Les chemins internes Ipmimon et l'API existante sont conservés pour préserver les
préférences du dashboard.

## État du livrable

Le dépôt est prêt à versionner et à construire avec le framework officiel des
plugins OPNsense. Ce dossier ne contient pas encore un binaire `.pkg` construit
et validé sous FreeBSD. Les scripts et tests ont été vérifiés localement sous
Linux/Windows ; construction, installation, mise à niveau et retrait réels doivent
être validés sur une instance OPNsense de test de même version/architecture que
la cible. Des tests directs des sources ont été effectués sur une instance
OPNsense privée, sans paquet. Les détails de cette instance et l'historique
des essais restent hors du dépôt Git.

Un dépôt Git seul ne rend pas le paquet installable depuis le gestionnaire.
Il faut construire le `.pkg`, publier un catalogue de paquets signé en HTTPS et
configurer ce dépôt sur les clients. Le plugin n'apparaîtra pas automatiquement
dans le dépôt officiel OPNsense. Voir [Publication](docs/PUBLISHING.md).

## Arborescence

```text
Makefile                    définition du plugin natif OPNsense
+PRE_INSTALL                contrôles de compatibilité et de collisions
+POST_INSTALL.post          message ajouté aux hooks natifs
+POST_DEINSTALL.post        rechargement configd après retrait
src/opnsense/               sources applicatives, installées sous /usr/local
scripts/build_package.py    construction via opnsense/plugins
scripts/install.sh          installation locale d'un .pkg contrôlé
scripts/uninstall.sh        retrait via pkg, sans forçage ni autoremove
scripts/legacy.py           sauvegarde/détachement/restauration du mode autonome
scripts/publish_repository.py  catalogue signé et configuration client
tests/                      tests simulés du collecteur, widget et packaging
docs/                       publication du dépôt signé
```

## Construire le paquet

Utiliser une **instance de construction isolée OPNsense**, correspondant à la
version et à l'architecture cibles, et non le firewall de production. Préparer
Python 3, PHP, make, pkg, ipmitool, les outils de développement requis par le
framework et un checkout officiel `opnsense/plugins` de la branche compatible.
Ne pas activer le dépôt FreeBSD générique pour obtenir ces dépendances.

Depuis la racine de ce dépôt, en root sur cette instance :

```sh
python3 -B scripts/build_package.py \
  --plugins-tree /usr/plugins \
  --maintainer 'you@example.invalid' \
  --website 'https://github.com/YOUR_ACCOUNT/ipmi-monitor' \
  --license BSD2CLAUSE
```

Remplacer les exemples par l'adresse du mainteneur et l'URL réelles. L'exemple
BSD2CLAUSE n'est pas un choix de licence effectué pour vous : choisir une licence
et ajouter son texte avant diffusion. Aucune licence ni identité de mainteneur
n'est attribuée implicitement par ce dépôt.

Le script lance les tests Python et la vérification PHP, copie les sources dans
`/usr/plugins/sysutils/ipmi-monitor` puis appelle `make package`. Il refuse
d'écraser ce répertoire s'il existe déjà. Pour une nouvelle construction,
conserver/déplacer ce répertoire manuellement après inspection, ou utiliser un
checkout neuf. Les fichiers du plugin ne sont pas installés par cette commande ;
le framework travaille dans son staging. Le script exige ipmitool déjà installé
pour éviter une installation implicite de cette dépendance par le framework.

Résultat attendu : `dist/packages/os-ipmi-monitor-1.0.0.pkg` (ou nom incluant le
suffixe produit par le framework). Le framework génère le manifeste, les
dépendances, la liste de fichiers et les annotations attendues par OPNsense.
Changer VERSION **et** PLUGIN_VERSION dans Makefile pour une nouvelle version.
Construire une publication distincte par ABI/architecture et branche OPNsense.

## Passer de l'installation autonome au paquet

Conserver d'abord l'archive autonome figée et une sauvegarde de configuration
OPNsense. Relever la disposition actuelle du widget. Cette migration ne touche
pas config.xml ni les préférences, mais une sauvegarde des six fichiers ne
constitue pas une sauvegarde de configuration.

Sur l'instance de test, avec le `.pkg` construit disponible :

```sh
python3 -B scripts/legacy.py check
python3 -B scripts/legacy.py detach
sh scripts/install.sh ./dist/packages/os-ipmi-monitor-1.0.0.pkg
```

`check` ne modifie rien. `detach`, exécuté en root, copie les six fichiers
existants dans un dossier unique sous `/var/backups/ipmi-monitor/`, vérifie leurs
SHA-256, enregistre un manifeste puis retire **uniquement** les copies installées.
Les fichiers appartenant à n'importe quel paquet sont refusés. Aucun dossier
n'est supprimé récursivement. Noter le chemin de sauvegarde affiché.

Faire detach et installation dans la même fenêtre de maintenance : entre les
deux, le collecteur et le widget ne sont plus disponibles. Le hook pre-install
refuse les fichiers autonomes non migrés, même si leur contenu est identique au
paquet. Il autorise les fichiers de la version précédente de os-ipmi-monitor.

En cas d'échec avant installation, restaurer :

```sh
python3 -B scripts/legacy.py restore --backup /var/backups/ipmi-monitor/DATE_A_REMPLACER
service configd restart
```

Si le paquet est partiellement ou totalement installé, vérifier `pkg info` et
le retirer avant une restauration. Le script refuse d'écraser un fichier
existant ; une restauration interrompue doit être inspectée manuellement.
Ne pas restaurer par-dessus un paquet géré par pkg.

## Installer, mettre à jour et retirer

Installation locale de laboratoire : `sh scripts/install.sh /chemin/paquet.pkg`.
Ce script vérifie le nom du paquet puis utilise `pkg add`, sans option de forçage.
ipmitool doit être installé au préalable depuis le dépôt OPNsense configuré.
Après publication du dépôt signé, les installations et mises à jour se font
normalement depuis Firmware / Plugins ou Packages, selon le filtre de la version.

Les hooks natifs rechargent configd et la configuration des plugins à
l'installation ; le hook de retrait recharge configd. Aucun reload des règles
firewall, changement de ventilateur, changement de seuil, reset BMC ou connexion
IPMI réseau n'est inclus. Aucun accès au BMC n'est lancé par les hooks de paquet.

Après installation : reconnecter la session web, ajouter **IPMI Monitor**, et
attribuer **Diagnostics: IPMI read-only** aux comptes autorisés. Tester
`configctl ipmimon snapshot`, l'API `/api/ipmimon/snapshot/get`, les options et la
persistance du dashboard. Pour retirer : `pkg delete os-ipmi-monitor`, ou via
l'interface. Ne pas utiliser autoremove sans examiner les autres dépendances.
Les préférences utilisateur et les tunables IPMI restent conservés.

Le collecteur lit les capteurs SDR avec la commande IPMI standard. Les trois
lectures OEM du mode ventilateur et des PWM sont définies dans
`src/opnsense/scripts/ipmimon/providers/supermicro.py`. Ce profil est sélectionné
explicitement dans `collector.py` pour l'installation Supermicro actuelle. Un
autre fournisseur peut avoir son propre module sans ajouter de commandes `raw`
au chemin commun ; seules des commandes de lecture fixes sont admises.

L'inventaire matériel utilise une action distincte :

```sh
configctl ipmimon inventory
```

L'API authentifiée correspondante est `/api/ipmimon/snapshot/inventory` et
partage le privilège **Diagnostics: IPMI read-only**. Elle renvoie séparément les
champs FRU disponibles (dont les numéros de série), les informations BMC et le
modèle de processeur vu par FreeBSD. Les seules lectures ajoutées sont
`ipmitool -I open fru print`, `ipmitool -I open mc info`,
`/sbin/sysctl -n hw.model`, `/bin/kenv smbios.planar.product` et
`/bin/kenv smbios.system.product`. Le résultat est mis en cache une heure ; le widget
continue de demander les mesures toutes les dix secondes sans lancer cet
inventaire. Les numéros de série sont renvoyés par l'API aux comptes autorisés,
mais ne sont pas affichés par défaut dans le widget. Le formulaire montre le nom
du système et le modèle de la carte mère lorsqu'ils sont disponibles. Sa section
Matériel permet de choisir les champs FRU, BMC, SMBIOS et processeur à afficher
avant les mesures ; aucun champ d'identité n'est sélectionné par défaut. Les
champs texte supplémentaires de `fru print` et `mc info` sont proposés dans la
liste, avec un maximum de 64 champs supplémentaires par appareil FRU et pour le
BMC. La case « Afficher le titre » contrôle l'affichage des noms de ces champs
dans le widget.

Le relevé `snapshot` énumère les capteurs réellement exposés par ce firewall.
Le widget construit sa liste de choix avec ces noms et conserve les nouveaux
capteurs comme choix possibles, même s'ils ne figurent dans aucun profil connu.
Les règles de lecture des champs FRU/BMC se trouvent dans le module fournisseur.
Les modèles de cartes Supermicro connus sont déclarés dans
`src/opnsense/scripts/ipmimon/providers/supermicro_boards.xml` : ajouter une
carte à ce fichier ne demande pas de modifier le code Python ou JavaScript.
Chaque profil associe un ou plusieurs motifs sur des champs FRU/BMC à des
capteurs et groupes suggérés. Pour l'A2SDi-TP8F, le modèle propose une
sélection initiale de températures, ventilateurs, DIMM, mode et PWM, ainsi que
les groupes FAN et mémoire. Il est choisi à partir des identités lues dans le
FRU ou le BMC et utilisé seulement en l'absence de choix enregistrés. Si le modèle est
inconnu ou le FRU indisponible, tous les capteurs découverts restent proposés
et aucun groupe propre à une carte n'est créé. Les préférences sauvegardées
gardent la priorité sur ce modèle initial.
Trois profils supplémentaires reconnaissent les cartes A2SDi-4C-HLN4F,
A2SDi-8C+-HLN4F et X10SDV-8C-TLN4F par leur modèle FRU ou SMBIOS, avec ou
sans préfixe `MBD-`. Ils proposent les températures et connecteurs ventilateur
communs à ces cartes ; seules les sondes effectivement découvertes sont
sélectionnées. Les A2SDi proposent une moyenne des températures DIMM si ces
sondes existent. Les A2SDi ne présument aucun regroupement des ventilateurs par
zone. Le X10SDV-8C-TLN4F propose `GRP_FAN0` (FAN1–3) et, si le BMC remonte
FANA, `GRP_FAN1` : sur PCB 2.00, FAN4 est la seconde zone et apparaît comme
FANA dans IPMI. Aucun mode OEM/PWM n'est présumé pour ces cartes non testées.
Références matériel : [A2SDi-4C-HLN4F](https://www.supermicro.com/en/products/motherboard/a2sdi-4c-hln4f),
[A2SDi-8C+-HLN4F](https://www.supermicro.com/en/products/motherboard/a2sdi-8c%2B-hln4f),
[X10SDV-8C-TLN4F](https://www.supermicro.com/en/products/motherboard/X10SDV-8C-TLN4F).
Six profils Embedded Xeon D supplémentaires couvrent
[X10SDV-7TP4F](https://www.supermicro.com/en/products/motherboard/X10SDV-7TP4F),
[X10SDV-16C-TLN4F](https://www.supermicro.com/en/products/motherboard/X10SDV-16C-TLN4F),
[X11SDV-4C-TP8F](https://www.supermicro.com/en/products/motherboard/X11SDV-4C-TP8F),
[X11SDV-8C-TP8F](https://www.supermicro.com/en/products/motherboard/X11SDV-8C-TP8F),
[X12SDV-4C-SPT8F](https://www.supermicro.com/en/products/motherboard/X12SDV-4C-SPT8F)
et [X12SDV-8C-SPT4F](https://www.supermicro.com/en/products/motherboard/X12SDV-8C-SPT4F).
Chaque modèle est reconnu par son nom exact, avec ou sans `MBD-`. Les connecteurs
et températures proposés varient selon la carte. Le X10SDV-16C-TLN4F suit
la même règle de zone que le X10SDV-8C-TLN4F. Sur les X11SDV-TP8F,
`GRP_FAN0` regroupe FAN1–4 et `GRP_FAN1` FANA/B. Les manuels consultés ne
précisent pas la répartition des connecteurs pour les X10SDV-7TP4F et
X12SDV-SPT ; aucun groupe de zone n'est donc prédéfini pour eux. Ces profils
devront être confrontés à des relevés SDR réels sur chaque modèle.
Références pour les zones : [X10SDV Mini-ITX, p. 2-20](https://www.supermicro.com/manuals/motherboard/D/MNL-1726.pdf),
[X11SDV-TP8F, p. 38](https://www.supermicro.com/manuals/motherboard/d/MNL-2007.pdf).
Les textes du widget sont appelés par des clés anglaises dans `Ipmimon.js`.
Les catalogues `src/opnsense/www/js/widgets/Locales/Ipmimon_en_US.xml` et
`Ipmimon_fr_FR.xml` sont livrés avec le plugin ; le widget choisit le catalogue
selon la langue du dashboard. `Metadata/Ipmimon.xml` déclare les mêmes clés
et leurs textes anglais pour l'intégration au dashboard OPNsense. Pour ajouter
ou modifier un libellé, mettre à jour les deux catalogues et les métadonnées.
Les anciens choix du widget ne sont pas migrés : le supprimer puis le recréer
pour obtenir la sélection initiale du profil matériel.
Les motifs sont insensibles à la casse ; un seul `*` final permet un préfixe
comme `FAN*` ou `DIMM*`. Les correspondances de carte peuvent porter sur
`fru.board.product`, `fru.product.name`, `fru.board.manufacturer`,
`bmc.manufacturer_name`, `bmc.product_name` ou `smbios.planar.product`.
Cette dernière valeur permet de reconnaître l'A2SDi-TP8F lorsque le FRU ne
fournit que le fabricant et le BMC le nom de famille A2SDi. Les entrées XML invalides sont
ignorées ; le test du collecteur vérifie le profil livré.

Le paquet ne charge pas automatiquement le pilote IPMI. Si nécessaire, définir
`ipmi_load=YES` dans System / Settings / Tunables et vérifier `/dev/ipmi0` au
prochain redémarrage planifié. L'absence de matériel IPMI n'empêche pas
l'installation pour tester l'interface ; les lectures sont alors indisponibles.

## Vérifications locales et publication

```sh
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_dynamic.mjs
sh -n scripts/install.sh
sh -n scripts/uninstall.sh
sh -n ./+PRE_INSTALL
sh -n ./+POST_INSTALL.post
sh -n ./+POST_DEINSTALL.post
```

Voir [la publication du dépôt signé](docs/PUBLISHING.md). Les résultats détaillés
des essais et l'historique de l'interface sont conservés hors du dépôt Git.

## Références

Packaging fondé sur le [framework officiel opnsense/plugins](https://github.com/opnsense/plugins/blob/master/Mk/plugins.mk)
et son [exemple HelloWorld](https://docs.opnsense.org/development/examples/helloworld.html).
Catalogue signé fondé sur [pkg-repo](https://man.freebsd.org/cgi/man.cgi?query=pkg-repo&sektion=8)
et [pkg.conf](https://man.freebsd.org/cgi/man.cgi?query=pkg.conf&sektion=5).
