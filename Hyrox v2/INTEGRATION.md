# Mise en production — Prépa Hyrox

Ce dossier contient trois pages reliées entre elles :

| Fichier | Rôle | Accès |
|---|---|---|
| `hyrox-training-club.html` | Site public : présentation, réservation, contrat, paiement carte | ouvert, cible du QR code |
| `hyrox-espace-coach.html` | Espace coach : planning, inscrits, encaissements, clôture des séances | Boris, Nino, Victor |
| `hyrox-admin.html` | Portail administrateur : historique des heures et du chiffre par coach | mot de passe unique |

Les trois fichiers doivent rester dans le même dossier, les liens entre eux sont relatifs.

## Identifiants

| Compte | Mot de passe |
|---|---|
| Boris | `Sled-Boris-54!` |
| Nino | `Wall-Nino-54!` |
| Victor | `SkiErg-Victor-54!` |
| Administrateur | `HYROX-ESSEY-ADMIN-2026` |

Ces mots de passe sont écrits dans le code des pages, donc lisibles par qui affiche le code source. Ils conviennent pour tester à trois, pas pour protéger de vraies données de clients. La section « Authentification » ci-dessous donne le remplacement.

## Ce qui fonctionne déjà, ce qui reste à brancher

**Fonctionne** — rotation hebdomadaire des coachs, seuil des trois personnes, contrat signé avec horodatage, sauvegarde partagée entre les trois pages, clôture des séances, comptage des heures et du chiffre par coach, exports CSV.

**À brancher** — le débit réel de la carte, l'envoi des emails et SMS, l'authentification, et le passage à PostgreSQL pour un stockage durable et sauvegardé.

---

## 1 · Base de données (Supabase)

Le stockage actuel est un espace clé-valeur partagé : suffisant pour la démonstration, mais sans requêtes ni sauvegarde. Voici le schéma cible.

```sql
create table coaches (
  id uuid primary key default gen_random_uuid(),
  prenom text not null unique,
  email text not null unique,
  siret text,
  actif boolean default true
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  slot smallint not null check (slot between 0 and 3),
  heure_debut time not null,
  heure_fin time not null,
  coach_id uuid references coaches(id),
  remplacement boolean default false,
  capacite smallint default 6,
  seuil smallint default 3,
  prix_cents integer default 1500,
  statut text default 'OUVERT'
    check (statut in ('OUVERT','CONFIRME','COMPLET','ANNULE','CLOTUREE')),
  cloturee_le timestamptz,
  unique (date, slot)
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  prenom text not null, nom text not null,
  email text not null, telephone text not null,
  date_naissance date, num_adherent text,
  niveau text, objectif text,
  cree_le timestamptz default now(),
  unique (email)
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  participant_id uuid references participants(id),
  statut text default 'EN_ATTENTE'
    check (statut in ('EN_ATTENTE','A_PAYER','PAYE','ANNULE','LISTE_ATTENTE')),
  presence boolean,
  cree_le timestamptz default now(),
  unique (session_id, participant_id)
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  version text not null,
  signature_nom text not null,
  mention text not null,
  droit_image boolean default false,
  signe_le timestamptz default now(),
  ip inet,
  pdf_url text
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  montant_cents integer not null,
  stripe_payment_intent text unique,
  statut text default 'CREE'
    check (statut in ('CREE','AUTORISE','PAYE','ECHOUE','REMBOURSE')),
  paye_le timestamptz,
  rembourse_le timestamptz
);
```

**Passage automatique à `CONFIRME`** — un trigger sur `bookings` recompte les inscriptions actives de la session, met `statut = 'CONFIRME'` au troisième, bascule les réservations concernées en `A_PAYER` et déclenche l'envoi des notifications.

**Rotation des coachs** — un coach prend le mercredi entier, le suivant prend celui d'après. Ancrage : mercredi 16 septembre 2026 = Boris.

```sql
create or replace function coach_du_jour(d date) returns text as $$
  select (array['Boris','Nino','Victor'])[
    ((floor((d - date '2026-09-16') / 7)::int % 3 + 3) % 3) + 1
  ];
$$ language sql immutable;
```

**Sécurité des lignes (RLS)** — un participant ne lit que ses propres réservations (via magic link), un coach lit les sessions dont il est titulaire, l'administrateur lit tout. Les clés de service ne sortent jamais du serveur.

---

## 2 · Paiement par carte (Stripe)

Le site ne doit jamais recevoir de numéro de carte : les champs sont rendus par Stripe dans des iframes, et seul Stripe voit les données. C'est ce qui évite la certification PCI-DSS complète.

**Enchaînement**

1. Le créneau atteint trois inscrits → le serveur crée un `PaymentIntent` de 1500 centimes par réservation à payer.
2. Le participant ouvre son lien → la page monte le Payment Element de Stripe avec le `client_secret`.
3. Il valide → Stripe confirme le paiement, gère l'authentification forte (3D Secure) sans code supplémentaire côté site.
4. Le webhook `payment_intent.succeeded` passe la réservation en `PAYE` et envoie le reçu.

**Côté serveur** (route `/api/payment-intent`, clé secrète jamais exposée) :

```js
const intent = await stripe.paymentIntents.create({
  amount: 1500,
  currency: "eur",
  automatic_payment_methods: { enabled: true },
  metadata: { booking_id, session_date, coach }
});
return { clientSecret: intent.client_secret };
```

**Côté page**, en remplacement du panneau de démonstration :

```js
const stripe = Stripe("pk_live_…");
const elements = stripe.elements({ clientSecret });
elements.create("payment").mount("#carte");

const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: "https://votre-domaine.fr/merci" }
});
```

**Remboursements** — `stripe.refunds.create({ payment_intent })`, à appeler quand un créneau est annulé faute de participants ou quand un participant annule plus de 24 h à l'avance.

**Avant d'encaisser** : le compte Stripe doit être ouvert au nom d'une structure déclarée (entreprise individuelle ou association), avec IBAN et pièce d'identité. Comptez deux jours ouvrés de vérification.

---

## 3 · Authentification

- **Participants** : lien magique par email, aucun mot de passe à retenir.
- **Coachs et administrateur** : comptes Supabase Auth avec mot de passe, plus un champ `role` dans la table `coaches` (`coach` ou `admin`). Les pages actuelles conservent leur interface, seul le bloc de connexion change.
- Activez la double authentification sur le compte administrateur : c'est lui qui voit l'ensemble des données personnelles et des chiffres.

---

## 4 · Notifications

| Déclencheur | Canal | Contenu |
|---|---|---|
| Inscription enregistrée | email | Confirmation, contrat signé en PDF |
| Créneau confirmé | email + SMS | Lien de paiement, 24 h pour régler |
| Relance | email | à H+12 si non payé |
| Rappel de séance | SMS | la veille à 18 h |
| Créneau annulé | email | Annulation, remboursement éventuel |

Resend ou Brevo pour l'email, Twilio ou Brevo pour le SMS. Le PDF du contrat se génère avec `pdf-lib` ou `react-pdf` à partir des données de `contracts`.

---

## 5 · Hébergement et QR code

Netlify ou Vercel suffisent : dépôt Git, domaine, HTTPS automatique. Nommez la page publique `index.html` au moment de la mise en ligne — pensez alors à corriger les liens internes des deux autres pages.

Le QR code pointe vers `https://votre-domaine.fr/?src=qr-salle` pour mesurer les scans. Générez-le en SVG, imprimez-le en A5, et testez-le au club : le réseau mobile y est souvent mauvais, un affichage lent décourage le scan.

---

## 6 · Points à trancher avant d'ouvrir

- **Qui encaisse.** Le contrat et le SIRET actuels sont ceux de Victor, mais Boris et Nino encadrent aussi. Soit chacun facture ses propres séances avec son SIRET, soit une structure commune encaisse tout et reverse. Le choix change la rédaction du contrat et le paramétrage de Stripe.
- **Le matériel du club.** Traîneau, sacs de sable, SkiErg : à vérifier sur place, la promesse du site doit correspondre à ce qui existe.
- **L'accord de Basic-Fit** pour l'affichage du QR code et l'activité commerciale sur place.
- **RGPD.** Désignez qui est responsable de traitement, prévoyez la suppression des données sur demande, et fixez une durée de conservation — trois ans après la dernière séance est un usage courant pour ce type d'activité.