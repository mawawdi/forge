# Last Light

Create a replayable rescue game in a failing orbital station. Recover three power cells, deliver them to the reactor and escape before the station goes dark. Build the world, controls, interface and ordinary Luau behavior from this brief in the clean seed place.

Use a 192-by-144-stud industrial station with a reactor, three cell bays, a shuttle and three dangerous conduits. Use seed 42017 for repeatable placement choices. Make the destinations and hazards easy to distinguish.

Each run begins with a three-second countdown and lasts 120 seconds. Carry one cell at a time; each reactor deposit awards 100 points. Begin with two integrity. Each conduit warns for 1.5 seconds, activates for two seconds and rests for 4.5 seconds. A hit removes one integrity and eight seconds. After all three deposits, hold the shuttle interaction for three seconds to win. Running out of time or integrity loses the run.

Provide menu, HUD and results screens, plus Start and Play Again actions. Show remaining time, cells, integrity and score. Make primary actions usable with touch and gamepad and at least 48 pixels across. Keep controls readable on phone and desktop.

Handle character loss and player departure deliberately. Each run resolves once. Ten consecutive win/loss/replay cycles must leave no stale callbacks, duplicate event subscriptions or transient objects. Keep gameplay state authoritative on the server and validate client requests.

These are creator-visible requirements. Source analysis, isolated tests, Studio play checks and creator review must supply their own evidence; declaring a requirement does not verify it.
