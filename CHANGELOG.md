# Historique

## En cours

- Champs FRU/BMC déplacés dans le fournisseur Supermicro et profils de cartes
  déclarés en XML, dont l'A2SDi-TP8F ;
  le widget énumère les capteurs réels et n'utilise le modèle que pour ses
  choix et groupes initiaux.
- Inventaire matériel séparé du relevé périodique : FRU, BMC et modèle de
  processeur, avec action configd et route API dédiées et cache d'une heure.
- Lectures OEM Supermicro isolées dans un module fournisseur ; collecte SDR et
  exécution bornée des commandes conservées dans le collecteur commun.
- Catégories internes harmonisées entre collecteur et widget : `Temps`, `Fans`,
  `Control`, `Voltages` et `Others` ; migration des catégories enregistrées
  précédemment dans les groupes et le catalogue.
- Correction du message d'indisponibilité du collecteur renvoyé par l'API.

## 1.0.0 — préparation initiale du paquet

- Sources autonomes IPMI Monitor 5.4.1 figées sans changement fonctionnel.
- Définition native os-ipmi-monitor pour le framework opnsense/plugins.
- Scripts de construction, installation locale et migration réversible des six fichiers.
- Préparation d'un dépôt signé avec confiance par clé publique.
- Tests et documentation de publication ; validation native FreeBSD à réaliser.
