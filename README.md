# fstock-scraper

Scraper Node.js pour extraire la disponibilité produit depuis deux fichiers Excel d'entrée et produire des sorties Excel homogènes, avec logs d'erreurs.

## Structure

- `scrape.js` (racine): script principal
- `in/`: fichiers d'entrée
  - `fichier1.xlsx` (liens en colonne B, id produit en colonne A)
  - `fichier2.xlsx` (référence en colonne A, lien en colonne B)
- `out/`: sorties Excel générées
  - `fichier1.availability.xlsx`
  - `fichier2.availability.xlsx`
- `log/`: journaux d'exécution
  - `log-YYYY-MM-DD_HHMMSS.txt`

## Installation

```
npm install
```

Node.js 18+ recommandé.

## Exécution

```
npm run start
```

Options:

- `--max=30` Limite de lignes à traiter par fichier (défaut 30)
- `--concurrency=5` Nombre de pages en parallèle
- `--headless=true|false` Mode headless ou non

Exemples:

```
node scrape.js --max=100 --concurrency=8 --headless=true
```

## Configuration (.env)

Vous pouvez définir les variables principales dans un fichier `.env` à la racine du projet. Les valeurs CLI (ex: `--max=…`) priment sur celles du `.env`.

- `IN_DIR`: dossier des fichiers d'entrée (défaut `in`)
- `OUT_DIR`: dossier de sortie des fichiers générés (défaut `out`)
- `LOG_DIR`: dossier des logs (défaut `log`)
- `MAX_ITEMS`: limite de lignes à traiter (défaut `30`)
- `CONCURRENCY`: nombre de pages en parallèle (défaut `5`)
- `HEADLESS`: `true`/`false` pour le mode headless (défaut `true`)

Exemple de `.env`:

```
IN_DIR=in
OUT_DIR=out
LOG_DIR=log
MAX_ITEMS=30
CONCURRENCY=5
HEADLESS=true
```

## Logique d'extraction

- Fichier 1: pour chaque URL, si 404 ou `#p-availability img` absent => 0. Si présent et texte/alt égal à "Disponibilità si" => 1, sinon 0. La référence en sortie est `REF-<id>`.
- Fichier 2: pour chaque URL, si 404 ou `#product-availability` absent ou ne contient pas `EN STOCK` => 0, sinon 1. La référence vient de la colonne A.

## Cron (exemple)

```
# */30 * * * * cd /chemin/vers/projet && /usr/bin/node scrape.js --max=1000 --concurrency=6 >> log/cron.out 2>&1
```
