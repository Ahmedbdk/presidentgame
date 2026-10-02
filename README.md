# President Game 🃏

A multiplayer web implementation of the **President (Asshole) card game**, built with **React, Node.js, Express, and Socket.IO**.

Players can create or join private rooms, receive cards, play against each other in real time, pass their turns, and receive ranks based on the order in which they finish.

## 🎮 Features

- 🏠 Create and join private rooms
- 🔑 4-character room codes
- 👥 Real-time multiplayer gameplay
- ⚡ Real-time communication using Socket.IO
- 🃏 Automatic card shuffling and dealing
- ❤️ Starting player determined by the **7♥**
- 🎴 Play single cards or sets of the same rank
- 💣 Four-of-a-kind acts as a bomb
- ⏭️ Pass turns
- 🔄 Automatically clear the table when all other active players pass
- 🏆 Automatic ranking when players finish their cards
- 👑 President / Vice President / Vice Asshole / Asshole roles
- 📱 Responsive game interface
- 🔄 Real-time turn and table updates

## 🃏 Game Rules

### Card Values

Cards are ordered from lowest to highest:

**2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → J → Q → K → A**

The **Ace is the highest normal card**.

### Starting the Game

- Cards are shuffled and distributed among the players.
- The player who has the **7♥** starts the game.
- If the 7♥ cannot be found, the first player starts.

### Playing Cards

A player can play:

- A single card
- A pair
- Three cards of the same rank
- Four cards of the same rank

When cards are played on an existing table:

- The player must play the **same number of cards** as the previous play.
- The played cards must have a **higher value** than the previous play.
- A **four-of-a-kind** acts as a bomb and has a higher value than normal plays.

### Passing

A player can pass instead of playing.

When all active players except the player who made the last play have passed:

- The table is cleared.
- The player who made the last play gets the turn again.
- A new round starts from that player.

Players who have already finished their cards are skipped when determining the next turn.

## 🏆 Player Rankings

Players are ranked according to the order in which they get rid of all their cards.

### More than 4 players

1. 👑 **President** — first player to finish
2. **Vice President** — second player to finish
3. **Normal** — players in the middle
4. **Vice Asshole** — second-to-last player
5. **Asshole** — last player

### 4 players or fewer

Only these special roles apply:

- 👑 **President** — first player to finish
- **Asshole** — last player to finish
- Other players are **Normal**

Vice President and Vice Asshole do **not** apply when there are 4 or fewer players.

## 🔄 Card Exchange Between Rounds

At the beginning of the next round, cards are exchanged according to the previous round's rankings.

### 4 players or fewer

- The **President** and the **Asshole** exchange **1 card**.

### More than 4 players

- The **President** and the **Asshole** exchange **2 cards**.
- The **Vice President** and the **Vice Asshole** exchange **1 card**.

## 🛠️ Tech Stack

### Frontend

- React
- Vite
- CSS
- Socket.IO Client

### Backend

- Node.js
- Express
- Socket.IO
- CORS

## 📁 Project Structure

```text
presidentgame/
├── backend/
│   ├── server.js
│   ├── package.json
│   └── ...
│
├── frontend/
│   ├── src/
│   │   ├── assets/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── index.css
│   │   └── main.jsx
│   ├── package.json
│   └── ...
│
├── DEPLOYMENT.md
├── LICENSE
└── README.md
```

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/Ahmedbdk/presidentgame.git
cd presidentgame
```

### 2. Install backend dependencies

```bash
cd backend
npm install
```

### 3. Install frontend dependencies

Open another terminal from the project root:

```bash
cd frontend
npm install
```

### 4. Start the backend

From the `backend` folder:

```bash
node server.js
```

The server runs on:

```text
http://localhost:3001
```

### 5. Start the frontend

From the `frontend` folder:

```bash
npm run dev
```

The frontend will normally be available at:

```text
http://localhost:5173
```

## 🎯 How to Play

1. Open the game in your browser.
2. Enter your username.
3. Create a room or join an existing room using its room code.
4. The host starts the game.
5. Cards are automatically distributed.
6. The player holding **7♥** starts.
7. Play cards or pass.
8. Continue until all players have finished.
9. Players receive their rankings based on finishing order.
10. At the beginning of the next round, cards are exchanged according to the rankings.

## ⚠️ Current Development Status

This project is currently under development.

The core multiplayer gameplay, room system, card dealing, turn management, passing system, ranking system, and real-time communication are implemented.

Future improvements may include:

- Improved card exchange interface
- More advanced game-state synchronization
- Better animations and visual feedback
- Spectator support
- Reconnection handling
- Persistent game rooms
- Additional game settings

## 📜 License

This project is licensed under the **MIT License**. See the `LICENSE` file for details.