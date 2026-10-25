// The MapKit JS token from /api/config, for the places map. Null: no map, the list only.
// A separate module, so the app shell does not load the chat code before the gate.
import { createContext } from "react";

export const MapTokenContext = createContext<string | null>(null);
