# Park Sense — full-stack local product prototype

This version keeps the Park Sense parking workflow but reworks the UI around a simpler, colorful, NHAI-inspired visual language. It is still a real local full-stack app: the browser talks to an Express backend and the backend persists parking, layout, account, reservation and settings data in `data/db.json`.

## Run on Windows

```bat
cd /d "C:\Users\Swarit Garg\Downloads\ParkSense_Simple_FullStack\ParkSense_Simple_FullStack"
npm install
npm start
```

Then open:

`http://localhost:3000`

## Demo accounts

Driver:
- Email: `driver@parksense.local`
- Password: `driver123`

Operator:
- Email: `operator@parksense.local`
- Password: `operator123`

## Included

### Driver
- Search parking facilities and demo destinations.
- Interactive Leaflet map with real map coordinates for the demo facilities.
- Integrated parking-space view; no external Google Maps redirect is required.
- Floors, areas and real-style bay labels such as `A-01`, `B-11`, etc.
- Available / occupied / reserved states from the backend data.
- Reserve and cancel a parking bay.
- My reservations.
- Notifications.
- Working dark mode and account/settings menu.
- Switch account / sign out.

### Operator
- Dedicated operator dashboard.
- Add another parking facility.
- Edit facility name, address, rate, status and coordinates.
- Delete a parking facility.
- Add, rename and delete levels/floors.
- Add, rename and delete areas.
- Add, rename, edit type/status and delete individual parking bays.
- Statistics for capacity, availability, occupancy, reservations, floors, areas and per-facility performance.
- Operator data is isolated by owner on the backend.

## Important data note

There is no fake "sensor simulator" in this version. Occupancy shown in Park Sense comes from the stored parking-state data in `data/db.json`. Operators can edit the stored state while configuring/testing a facility. A real sensor gateway can later update the same backend endpoints/database.

## Map note

The demo facilities use actual Delhi/NCR-area coordinates. DLF Promenade is placed at its parking/facility location rather than on an airport runway.

## Production path

For a judged/product deployment, replace the local JSON database with PostgreSQL/Supabase, use HTTPS, persistent sessions and real parking/sensor integrations. The UI/API separation in this prototype is already designed around that migration.
