# Serveur en ligne de Northskye — déploiement gratuit (Render)

Le serveur ne connaît pas les règles : il met deux joueurs en relation grâce à un code de partie et leur transmet leurs messages.
Chaque jeu fait tourner le moteur de règles ; les deux parties restent identiques parce que le moteur est déterministe.

## Tester en local (sans rien héberger)

```
cd server
npm install
node server.js          # écoute sur le port 8080
```

Dans le jeu : **Options → Serveur en ligne** : `ws://127.0.0.1:8080`, puis lancez deux fois le jeu
(un joueur crée la partie, l'autre la rejoint avec le code).

## Héberger gratuitement sur Render (≈ 10 minutes)

1. Créez un compte gratuit sur **github.com**, puis un dépôt (par exemple `northskye-relay`, privé ou public).
2. Envoyez-y **le contenu du dossier `server/`** (`server.js`, `package.json`, `render.yaml`, `.gitignore`) :
   bouton « Add file → Upload files » sur la page du dépôt, c'est suffisant.
3. Créez un compte gratuit sur **render.com** (connexion possible avec GitHub).
4. **New + → Blueprint** → choisissez votre dépôt → *Apply*. (Le fichier `render.yaml` remplit tout : service web gratuit nommé `northskye-relay`.)
   Sans Blueprint : New + → Web Service → votre dépôt → Runtime *Node*, Build `npm install`, Start `node server.js`, Instance *Free*.
5. Au bout de 2-3 minutes, ouvrez `https://northskye-relay.onrender.com/health` : le texte « Northskye relay OK » s'affiche.

### Adresse dans le jeu

- Si votre service s'appelle bien `northskye-relay`, **rien à faire** : le jeu vise déjà `wss://northskye-relay.onrender.com`.
- Sinon (nom pris, autre hébergeur…) : **Options → Serveur en ligne** et collez l'adresse en remplaçant `https://` par `wss://`.
  Pour que vos amis n'aient rien à régler, changez aussi la constante `DEFAULT_SERVER` dans `src/core/session.gd`.

## Bon à savoir

- **Réveil** : l'offre gratuite endort le serveur après ~15 minutes sans activité. La première connexion peut alors prendre 30 à 60 secondes
  (le jeu affiche un message et réessaie tout seul). Pendant une partie, les connexions gardent le serveur éveillé.
- **Coupure** : si le réseau d'un joueur tombe, ou si le serveur redémarre en pleine partie, le jeu se reconnecte seul et les deux joueurs se resynchronisent.
  Pendant ce temps, l'autre joueur voit « Adversaire déconnecté » et la partie attend.
- **Même version** : les deux joueurs doivent avoir exactement la même version du jeu (le jeu le vérifie au lancement et refuse sinon).
- **Triche** : chaque jeu connaît l'état complet de la partie (c'est ce qui permet de ne rien envoyer d'autre que les commandes).
  Entre amis ça n'a pas d'importance ; pour un jeu public il faudrait un serveur qui fait autorité.
- Sans base de données, le serveur ne garde rien de durable : une salle disparaît quand il redémarre (les jeux la recréent automatiquement) ou quand tout le monde est parti depuis 6 heures.

## Classement en ligne (base de données gratuite)

Le serveur tient un classement des joueurs en ligne (cote de type Elo, départ 1000). Il n'est **durable** que si vous lui donnez une base PostgreSQL ;
sans base, il utilise un fichier qui est **effacé à chaque redémarrage** de l'offre gratuite de Render (le jeu fonctionne, mais le classement repart de zéro).

### Créer la base gratuite (≈ 5 minutes, sans carte bancaire)

1. Créez un compte sur **neon.tech** (offre « Free », connexion possible avec GitHub) puis un projet (région Europe, par exemple Frankfurt).
2. Sur le tableau de bord du projet, copiez la **Connection string** (elle commence par `postgresql://…`).
   (Alternative équivalente : **supabase.com** → New project → Project Settings → Database → Connection string, en mode *Session pooler*.)
3. Sur **render.com** → votre service `northskye-relay` → **Environment** → *Add Environment Variable* :
   `DATABASE_URL` = la chaîne copiée. Enregistrez : le service redémarre.
4. Vérifiez : `https://northskye-relay.onrender.com/health` doit afficher « classement actif », et les tables `players` / `games` sont créées toutes seules.

Les offres gratuites suffisent largement (le classement ne stocke que quelques lignes par joueur). Neon endort la base après quelques minutes d'inactivité et la réveille à la première requête (≈ 1 s).

### Comment les parties sont comptées

- Chaque jeu possède un identifiant secret (dans `user://ladder.cfg`) : il empêche quelqu'un d'autre d'utiliser votre nom de classement. Ne le partagez pas.
- À la fin d'une partie en ligne, **chaque joueur envoie son résultat** (vainqueur, empreinte de l'état final, nombre de commandes). Le serveur ne compte la partie que si les deux rapports concordent
  (le moteur de règles étant identique des deux côtés, un désaccord signale une triche ou une désynchronisation : la partie n'est alors pas comptée).
- Une défaite déclarée par un joueur est validée seule après 1 minute si l'adversaire ne dit rien ; une victoire déclarée seule n'est jamais validée.
- Quitter volontairement une partie en cours (après 3 minutes de jeu) compte comme une défaite.
- Une coupure de réseau ne compte pas comme un abandon : la partie peut reprendre.
- Limite connue : rien n'empêche quelqu'un de jouer contre un second compte à lui pour gagner des points.
- Le classement s'affiche dans **Classement** (menu principal) : les 10 premiers et votre position.
