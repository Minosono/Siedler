// --- Konfiguration - BITTE ANPASSEN ---
const API_KEY = 'DEIN_API_SCHLUESSEL'; // Optional, wenn nur mit OAuth gearbeitet wird
const CLIENT_ID = 'DEIN_CLIENT_ID.apps.googleusercontent.com'; // Ersetze dies!
const SPREADSHEET_ID = 'DEINE_TABELLEN_ID'; // Ersetze dies!

// --- Bereiche (Scopes) für Google API Zugriff ---
// Braucht Zugriff auf Sheets UND um Nutzerinfo (E-Mail) zu lesen
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';

// --- Google Sheet Namen & Bereiche ---
const SHEET_GRUPPEN = 'Gruppen';
const RANGE_GRUPPEN = `${SHEET_GRUPPEN}!A:B`;
const SHEET_GEBIETE = 'Gebiete';
const RANGE_GEBIETE = `${SHEET_GEBIETE}!A:M`; // A=ID, B=Name, C=Email, D-M=Rohstoffe
const SHEET_SIEDLUNGEN = 'Siedlungen';
const RANGE_SIEDLUNGEN = `${SHEET_SIEDLUNGEN}!A:E`; // A=Timestamp, B=GroupID, C=GebietID, D=Typ, E=Email

// --- Globale Variablen ---
let tokenClient;
let gapiInited = false;
let gisInited = false;
let currentUserEmail = null;
let assignedArea = null; // { id: 'NORD', name: 'Nord-Region', row: 2, resources: {...} }
let allGroups = []; // Array von { id: 'G1', name: 'Name', row: 2 }
let allSettlements = []; // Array von { timestamp, groupId, areaId, type, email }
let allAreas = []; // Array von { id, name, email, resources, row }

// --- DOM Elemente ---
const authorizeButton = document.getElementById('authorize_button');
const signoutButton = document.getElementById('signout_button');
const authStatus = document.getElementById('auth-status');
const authContainer = document.getElementById('auth-container');
const areaSelectionContainer = document.getElementById('area-selection');
const areaButtonsContainer = document.getElementById('area-buttons');
const areaSelectionStatus = document.getElementById('area-selection-status');
const mainAppContainer = document.getElementById('main-app');
const areaTitle = document.getElementById('area-title');
const userEmailSpan = document.getElementById('user-email');
const resourceTotalsDiv = document.getElementById('resource-totals');
const gruppenListeUl = document.querySelector('#gruppen-liste ul');
const gruppenListeStatus = document.querySelector('#gruppen-liste p.loading');
const refreshButton = document.getElementById('refresh-button');
const appStatus = document.getElementById('app-status');
const errorMessage = document.getElementById('error-message');
const lastUpdatedSpan = document.getElementById('last-updated');

// --- Initialisierungsfunktionen ---

function gapiLoaded() {
    gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
    try {
        await gapi.client.init({
            // apiKey: API_KEY, // API Key wird nicht benötigt wenn OAuth2 verwendet wird
            discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
        });
        gapiInited = true;
        maybeEnableButtons();
        console.log("GAPI Client initialisiert.");
    } catch (err) {
        showError("Fehler beim Initialisieren des GAPI Clients.", err);
    }
}

function gisLoaded() {
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: '', // Callback wird pro Request gesetzt
        });
        gisInited = true;
        maybeEnableButtons();
        console.log("GIS Client initialisiert.");
         // Automatisch versuchen, sich anzumelden, wenn bereits eine Sitzung besteht
        google.accounts.oauth2.triggerTokenRetrieval(SCOPES);

    } catch (err) {
        showError("Fehler beim Initialisieren des GIS Clients.", err);
    }
}

function maybeEnableButtons() {
    if (gapiInited && gisInited) {
        authorizeButton.disabled = false;
        authStatus.textContent = "Bereit zur Anmeldung.";
        authorizeButton.onclick = handleAuthClick;
        signoutButton.onclick = handleSignoutClick;
        refreshButton.onclick = refreshAllData;
        console.log("Auth Buttons aktiviert.");
    }
}

// --- Authentifizierungsfunktionen ---

function handleAuthClick() {
    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) {
            throw (resp);
        }
        authStatus.textContent = "Erfolgreich angemeldet.";
        authorizeButton.classList.add('hidden');
        signoutButton.classList.remove('hidden');
        await fetchUserInfoAndLoadData(); // Nutzerinfo holen und Daten laden
    };

    // Wenn Nutzer noch kein Token hat (erstes Mal oder nach Logout)
    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        // Wenn schon ein Token existiert (z.B. Seite neu geladen), dieses nutzen
         tokenClient.requestAccessToken({ prompt: '' }); // Kein Consent nötig
    }
}

function handleSignoutClick() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token, () => {
            gapi.client.setToken('');
            authStatus.textContent = "Abgemeldet.";
            authorizeButton.classList.remove('hidden');
            signoutButton.classList.add('hidden');
            authContainer.classList.remove('hidden');
            areaSelectionContainer.classList.add('hidden');
            mainAppContainer.classList.add('hidden');
            currentUserEmail = null;
            assignedArea = null;
            // Ggf. Intervall stoppen
        });
    }
}

async function fetchUserInfoAndLoadData() {
     try {
        // Google Nutzerinfo API aufrufen, um E-Mail zu erhalten
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                'Authorization': `Bearer ${gapi.client.getToken().access_token}`
            }
        });
        if (!userInfoResponse.ok) {
            throw new Error(`Fehler beim Abrufen der Nutzerinfo: ${userInfoResponse.statusText}`);
        }
        const userInfo = await userInfoResponse.json();
        currentUserEmail = userInfo.email;
        userEmailSpan.textContent = currentUserEmail;
        console.log("Angemeldet als:", currentUserEmail);

        authContainer.classList.add('hidden'); // Verstecke Auth-Bereich
        await checkAreaAssignment(); // Prüfen ob Gebiet zugewiesen ist

    } catch (err) {
        showError("Fehler beim Abrufen der Nutzerinformationen oder Laden der Daten.", err);
        handleSignoutClick(); // Bei Fehler abmelden
    }
}


// --- Kernlogik: Daten laden und anzeigen ---

async function checkAreaAssignment() {
    showLoading("Prüfe Gebietszuweisung...");
    try {
        const gebieteData = await getSheetData(RANGE_GEBIETE);
        allAreas = parseGebieteData(gebieteData.values); // Lade alle Gebiete für spätere Verwendung

        assignedArea = allAreas.find(area => area.email && area.email.toLowerCase() === currentUserEmail.toLowerCase());

        if (assignedArea) {
            console.log(`Nutzer ist Gebiet ${assignedArea.name} zugewiesen.`);
            areaSelectionContainer.classList.add('hidden');
            mainAppContainer.classList.remove('hidden');
            hideLoading();
            await loadInitialAppData(); // Lade Gruppen und Siedlungen
        } else {
            console.log("Nutzer ist keinem Gebiet zugewiesen.");
            mainAppContainer.classList.add('hidden');
            areaSelectionContainer.classList.remove('hidden');
            displayAreaSelectionButtons();
            hideLoading();
        }
    } catch (err) {
        showError("Fehler beim Prüfen der Gebietszuweisung.", err);
    }
}

function displayAreaSelectionButtons() {
    areaButtonsContainer.innerHTML = ''; // Alte Buttons entfernen
    allAreas.forEach(area => {
        // Zeige nur Buttons für Gebiete an, die noch KEINEN Mitarbeiter zugewiesen haben
        if (!area.email) {
            const button = document.createElement('button');
            button.textContent = area.name;
            button.onclick = () => handleAreaSelection(area);
            areaButtonsContainer.appendChild(button);
        }
    });
    if (areaButtonsContainer.childElementCount === 0) {
         areaButtonsContainer.innerHTML = '<p>Alle Gebiete sind bereits Mitarbeitern zugewiesen.</p>';
    }
}

async function handleAreaSelection(area) {
    areaSelectionStatus.textContent = `Wähle Gebiet ${area.name}...`;
    areaSelectionStatus.classList.remove('hidden');
    areaButtonsContainer.querySelectorAll('button').forEach(b => b.disabled = true); // Buttons deaktivieren

    try {
        // Zuerst NOCHMAL prüfen, ob das Gebiet inzwischen belegt wurde
        const currentGebieteData = await getSheetData(RANGE_GEBIETE);
        const currentAreas = parseGebieteData(currentGebieteData.values);
        const targetAreaOnline = currentAreas.find(a => a.id === area.id);

        if (targetAreaOnline && targetAreaOnline.email) {
             showError(`Gebiet "${area.name}" wurde inzwischen von ${targetAreaOnline.email} gewählt.`);
             areaSelectionStatus.classList.add('hidden');
             displayAreaSelectionButtons(); // Aktualisiere Buttons
             return;
        }

        // Gebiet ist frei, E-Mail eintragen
        const rangeToUpdate = `${SHEET_GEBIETE}!C${area.row}`; // Zelle C in der Zeile des Gebiets
        await updateSheetData(rangeToUpdate, [[currentUserEmail]]);

        console.log(`Gebiet ${area.name} erfolgreich für ${currentUserEmail} reserviert.`);
        assignedArea = area; // Gebiet lokal zuweisen
        assignedArea.email = currentUserEmail; // Update lokale Daten

        areaSelectionContainer.classList.add('hidden');
        mainAppContainer.classList.remove('hidden');
        areaSelectionStatus.classList.add('hidden');
        await loadInitialAppData(); // Lade Rest der Daten

    } catch (err) {
        showError(`Fehler beim Auswählen des Gebiets ${area.name}.`, err);
        areaSelectionStatus.classList.add('hidden');
        areaButtonsContainer.querySelectorAll('button').forEach(b => b.disabled = false); // Buttons wieder aktivieren
    }
}


async function loadInitialAppData() {
    showLoading("Lade Spieldaten (Gruppen, Siedlungen)...");
    try {
        // Paralleles Laden von Gruppen und Siedlungen
        const [gruppenData, siedlungenData] = await Promise.all([
            getSheetData(RANGE_GRUPPEN),
            getSheetData(RANGE_SIEDLUNGEN)
        ]);

        allGroups = parseGruppenData(gruppenData.values);
        allSettlements = parseSiedlungenData(siedlungenData.values);

        console.log("Gruppen:", allGroups);
        console.log("Siedlungen:", allSettlements);

        renderUI();
        hideLoading();
        startAutoRefresh(); // Starte automatische Aktualisierung
    } catch (err) {
        showError("Fehler beim Laden der initialen Spieldaten.", err);
        hideLoading();
    }
}

async function refreshAllData() {
     showLoading("Lade Daten neu...");
     errorMessage.classList.add('hidden'); // Alten Fehler verstecken
     try {
        // Alle relevanten Daten neu laden
         const [gruppenData, siedlungenData, gebieteData] = await Promise.all([
            getSheetData(RANGE_GRUPPEN),
            getSheetData(RANGE_SIEDLUNGEN),
            getSheetData(RANGE_GEBIETE) // Auch Gebiete neu laden, falls Zuweisung geändert wurde
        ]);

        allGroups = parseGruppenData(gruppenData.values);
        allSettlements = parseSiedlungenData(siedlungenData.values);
        allAreas = parseGebieteData(gebieteData.values); // Gebietsdaten aktualisieren

        // Prüfen, ob die Gebietszuweisung noch stimmt
        const currentAssignment = allAreas.find(area => area.email && area.email.toLowerCase() === currentUserEmail.toLowerCase());
        if (!currentAssignment) {
            // Der Nutzer hat keine Zuweisung mehr! Zurück zur Auswahl
            console.warn("Gebietszuweisung verloren!");
            assignedArea = null;
            stopAutoRefresh();
            mainAppContainer.classList.add('hidden');
            areaSelectionContainer.classList.remove('hidden');
            displayAreaSelectionButtons();
            hideLoading();
            showError("Deine Gebietszuweisung wurde entfernt. Bitte wähle ein neues Gebiet.");
            return; // Wichtig: Nicht weiter rendern
        } else if (currentAssignment.id !== assignedArea.id) {
            // Gebiet hat sich geändert (unwahrscheinlich, aber möglich)
            console.warn("Gebietszuweisung hat sich geändert!");
            assignedArea = currentAssignment;
        }


        renderUI();
        hideLoading();
        lastUpdatedSpan.textContent = `Zuletzt aktualisiert: ${new Date().toLocaleTimeString()}`;

     } catch (err) {
         showError("Fehler beim Aktualisieren der Daten.", err);
         hideLoading();
     }
}

function renderUI() {
    if (!assignedArea || !allGroups.length) {
        console.warn("Rendern abgebrochen: Kein Gebiet zugewiesen oder keine Gruppen geladen.");
        return;
    }

    areaTitle.textContent = `Dein Gebiet: ${assignedArea.name}`;
    gruppenListeUl.innerHTML = ''; // Leere alte Liste
    gruppenListeStatus.classList.add('hidden');

    // 1. Siedlungen filtern, die zu meinem Gebiet gehören
    const settlementsInMyArea = allSettlements.filter(s => s.areaId === assignedArea.id);

    // 2. Gruppenliste erstellen und Siedlungen zählen
    allGroups.forEach(group => {
        const groupSettlements = settlementsInMyArea.filter(s => s.groupId === group.id);
        const villageCount = groupSettlements.filter(s => s.type.toLowerCase() === 'dorf').length;
        const cityCount = groupSettlements.filter(s => s.type.toLowerCase() === 'stadt').length;

        const li = document.createElement('li');
        li.innerHTML = `
            <strong>${group.name}</strong> (ID: ${group.id})
            <div class="group-details">
                <span>Dörfer: ${villageCount}</span>
                <span>Städte: ${cityCount}</span>
            </div>
            <div>
                <button onclick="addSettlement('${group.id}', 'Dorf')">+ Dorf</button>
                <button onclick="addSettlement('${group.id}', 'Stadt')">+ Stadt</button>
                <button onclick="removeSettlement('${group.id}', 'Dorf')">- Dorf</button>
                <button onclick="removeSettlement('${group.id}', 'Stadt')">- Stadt</button>
                <button onclick="renameGroup('${group.id}', '${group.name}', ${group.row})">Umbenennen</button>
            </div>
        `;
        gruppenListeUl.appendChild(li);
    });

    // 3. Rohstoffproduktion berechnen und anzeigen
    calculateAndDisplayResources(settlementsInMyArea);

    lastUpdatedSpan.textContent = `Zuletzt aktualisiert: ${new Date().toLocaleTimeString()}`;
}

function calculateAndDisplayResources(settlementsInArea) {
     const totals = { Holz: 0, Lehm: 0, Wolle: 0, Getreide: 0, Erz: 0 };
     const resDef = assignedArea.resources; // Rohstoffdefinitionen für dieses Gebiet

     allGroups.forEach(group => {
         const groupSettlements = settlementsInArea.filter(s => s.groupId === group.id);
         const villageCount = groupSettlements.filter(s => s.type.toLowerCase() === 'dorf').length;
         const cityCount = groupSettlements.filter(s => s.type.toLowerCase() === 'stadt').length;

         totals.Holz += (villageCount * (resDef.Holz_Dorf || 0)) + (cityCount * (resDef.Holz_Stadt || 0));
         totals.Lehm += (villageCount * (resDef.Lehm_Dorf || 0)) + (cityCount * (resDef.Lehm_Stadt || 0));
         totals.Wolle += (villageCount * (resDef.Wolle_Dorf || 0)) + (cityCount * (resDef.Wolle_Stadt || 0));
         totals.Getreide += (villageCount * (resDef.Getreide_Dorf || 0)) + (cityCount * (resDef.Getreide_Stadt || 0));
         totals.Erz += (villageCount * (resDef.Erz_Dorf || 0)) + (cityCount * (resDef.Erz_Stadt || 0));
     });

     resourceTotalsDiv.innerHTML = `
        <span>Holz: ${totals.Holz}</span>
        <span>Lehm: ${totals.Lehm}</span>
        <span>Wolle: ${totals.Wolle}</span>
        <span>Getreide: ${totals.Getreide}</span>
        <span>Erz: ${totals.Erz}</span>
     `;
}

// --- Datenmanipulationsfunktionen ---

async function addSettlement(groupId, type) {
    showLoading(`Füge ${type} für Gruppe ${groupId} hinzu...`);
    try {
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const values = [[
            timestamp,
            groupId,
            assignedArea.id,
            type,
            currentUserEmail
        ]];
        await appendSheetData(SHEET_SIEDLUNGEN, values);
        console.log(`${type} für ${groupId} in ${assignedArea.id} hinzugefügt.`);
        await refreshAllData(); // Daten neu laden und UI aktualisieren
    } catch (err) {
        showError(`Fehler beim Hinzufügen von ${type} für ${groupId}.`, err);
    } finally {
        hideLoading();
    }
}

async function removeSettlement(groupId, type) {
    showLoading(`Entferne ${type} für Gruppe ${groupId}...`);
    try {
        // Finde die *letzte* Siedlung dieses Typs für diese Gruppe in diesem Gebiet
        // WICHTIG: Das Google Sheets API erlaubt kein direktes Löschen basierend auf Werten.
        // Man muss die Zeilennummer kennen oder komplexere Batch-Updates verwenden.
        // Einfachster Ansatz hier: Finde die Zeilennummer der letzten Übereinstimmung.

        // 1. Aktuelle Siedlungen holen (um die neuesten Zeilennummern zu haben)
        const siedlungenResponse = await getSheetData(RANGE_SIEDLUNGEN);
        const currentSettlementsRaw = siedlungenResponse.values || [];

        let rowIndexToDelete = -1;
        // Iteriere von unten nach oben, um die letzte zu finden
        for (let i = currentSettlementsRaw.length - 1; i >= 0; i--) {
            const row = currentSettlementsRaw[i];
            // Annahme: Spalten B=GroupID, C=GebietID, D=Typ (Index 1, 2, 3)
            if (row[1] === groupId && row[2] === assignedArea.id && row[3].toLowerCase() === type.toLowerCase()) {
                rowIndexToDelete = i + 1; // Google Sheets Zeilen sind 1-basiert
                break;
            }
        }

        if (rowIndexToDelete === -1) {
            showError(`Kein ${type} für Gruppe ${groupId} in diesem Gebiet gefunden zum Entfernen.`);
            hideLoading();
            return;
        }

        // 2. Lösch-Request vorbereiten (BatchUpdate ist sicherer)
         const batchUpdateRequest = {
            requests: [
                {
                    deleteDimension: {
                        range: {
                            sheetId: await getSheetIdByName(SHEET_SIEDLUNGEN), // Braucht Sheet ID, nicht Name!
                            dimension: "ROWS",
                            startIndex: rowIndexToDelete - 1, // 0-basiert für API
                            endIndex: rowIndexToDelete
                        }
                    }
                }
            ]
        };

        await gapi.client.sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: batchUpdateRequest,
        });


        console.log(`${type} für ${groupId} in ${assignedArea.id} (Zeile ${rowIndexToDelete}) entfernt.`);
        await refreshAllData(); // Daten neu laden und UI aktualisieren

    } catch (err) {
        showError(`Fehler beim Entfernen von ${type} für ${groupId}.`, err);
    } finally {
        hideLoading();
    }
}

async function renameGroup(groupId, oldName, groupRowIndex) {
     const newName = prompt(`Neuen Namen für Gruppe "${oldName}" (ID: ${groupId}) eingeben:`, oldName);
     if (newName && newName.trim() !== '' && newName !== oldName) {
         showLoading(`Benenne Gruppe ${groupId} um...`);
         try {
            const rangeToUpdate = `${SHEET_GRUPPEN}!B${groupRowIndex}`; // Spalte B (Name) in der Zeile der Gruppe
            await updateSheetData(rangeToUpdate, [[newName.trim()]]);
            console.log(`Gruppe ${groupId} umbenannt zu ${newName.trim()}.`);
            await refreshAllData(); // Neu laden
         } catch (err) {
            showError(`Fehler beim Umbenennen der Gruppe ${groupId}.`, err);
         } finally {
             hideLoading();
         }
     }
}


// --- Hilfsfunktionen ---

// Parst die Rohdaten aus dem 'Gebiete' Sheet
function parseGebieteData(values) {
    if (!values || values.length < 2) return []; // Mindestens Header + 1 Datenzeile
    const headers = values[0].map(h => h.trim()); // Headerzeile
    const idIndex = headers.indexOf('GebietID');
    const nameIndex = headers.indexOf('Gebietsname');
    const emailIndex = headers.indexOf('ZustaendigerMitarbeiterEmail');

    return values.slice(1).map((row, index) => {
        const resources = {};
         headers.forEach((header, hIndex) => {
             if (header.includes('_Dorf') || header.includes('_Stadt')) {
                 resources[header] = parseInt(row[hIndex], 10) || 0; // Rohstoffwerte als Zahlen
             }
         });

        return {
            id: row[idIndex] || null,
            name: row[nameIndex] || 'Unbenannt',
            email: row[emailIndex] || null,
            resources: resources,
            row: index + 2 // Zeilennummer im Sheet (1-basiert, Header ist 1)
        };
    }).filter(area => area.id); // Nur Gebiete mit ID behalten
}

// Parst die Rohdaten aus dem 'Gruppen' Sheet
function parseGruppenData(values) {
    if (!values || values.length < 2) return [];
    const headers = values[0];
    const idIndex = headers.indexOf('GroupID');
    const nameIndex = headers.indexOf('Gruppenname');
    return values.slice(1).map((row, index) => ({
        id: row[idIndex] || null,
        name: row[nameIndex] || `Gruppe ${index + 1}`,
        row: index + 2 // Zeilennummer im Sheet
    })).filter(group => group.id);
}

// Parst die Rohdaten aus dem 'Siedlungen' Sheet
function parseSiedlungenData(values) {
    if (!values || values.length < 2) return [];
    const headers = values[0];
    const tsIndex = headers.indexOf('Timestamp');
    const groupIndex = headers.indexOf('GroupID');
    const areaIndex = headers.indexOf('GebietID');
    const typeIndex = headers.indexOf('Siedlungstyp');
    const emailIndex = headers.indexOf('MitarbeiterEmail');
    return values.slice(1).map(row => ({
        timestamp: row[tsIndex] || null,
        groupId: row[groupIndex] || null,
        areaId: row[areaIndex] || null,
        type: row[typeIndex] || 'Unbekannt',
        email: row[emailIndex] || null
    })).filter(s => s.groupId && s.areaId); // Nur gültige Einträge
}


// Hilfsfunktion zum Abrufen der Sheet-ID anhand des Namens (wird für Batch-Updates benötigt)
let sheetIdMap = {}; // Cache für Sheet IDs
async function getSheetIdByName(sheetName) {
    if (sheetIdMap[sheetName]) {
        return sheetIdMap[sheetName];
    }
    try {
        const response = await gapi.client.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            fields: 'sheets(properties(sheetId,title))' // Nur benötigte Felder abfragen
        });
        const sheets = response.result.sheets;
        sheets.forEach(sheet => {
            sheetIdMap[sheet.properties.title] = sheet.properties.sheetId;
        });
        if (!sheetIdMap[sheetName]) {
             throw new Error(`Sheet mit Namen "${sheetName}" nicht gefunden.`);
        }
        return sheetIdMap[sheetName];
    } catch (err) {
        console.error("Fehler beim Abrufen der Sheet ID für", sheetName, err);
        throw err; // Fehler weitergeben
    }
}


// Wrapper für API-Aufrufe zum Lesen
async function getSheetData(range) {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
        });
        return response.result;
    } catch (err) {
        console.error(`Fehler beim Lesen von Bereich ${range}:`, err);
        // Spezifische Fehlerbehandlung für Authentifizierung
        if (err.result && err.result.error && err.result.error.status === 'UNAUTHENTICATED') {
             showError("Authentifizierung erforderlich oder abgelaufen. Bitte neu anmelden.", null, false);
             // Erneut Authentifizierung anfordern
             tokenClient.requestAccessToken({prompt: 'consent'});
        }
        throw err; // Fehler weitergeben, damit aufrufende Funktion ihn behandeln kann
    }
}

// Wrapper für API-Aufrufe zum Schreiben (Aktualisieren)
async function updateSheetData(range, values) {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
            valueInputOption: 'USER_ENTERED', // Daten so behandeln, als wären sie vom Nutzer eingegeben
            resource: {
                values: values
            },
        });
        return response.result;
    } catch (err) {
         console.error(`Fehler beim Schreiben in Bereich ${range}:`, err);
         if (err.result && err.result.error && err.result.error.status === 'UNAUTHENTICATED') {
             showError("Authentifizierung erforderlich oder abgelaufen. Bitte neu anmelden.", null, false);
             tokenClient.requestAccessToken({prompt: 'consent'});
         } else if (err.result && err.result.error && err.result.error.status === 'PERMISSION_DENIED') {
              showError("Keine Berechtigung zum Schreiben in die Tabelle. Stelle sicher, dass die Tabelle für dich freigegeben ist.", err);
         }
        throw err;
    }
}

// Wrapper für API-Aufrufe zum Anhängen von Daten
async function appendSheetData(sheetName, values) {
     try {
        const response = await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: sheetName, // Nur Sheet-Name für Append
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS', // Neue Zeile(n) einfügen
            resource: {
                values: values
            },
        });
        return response.result;
    } catch (err) {
         console.error(`Fehler beim Anhängen an Sheet ${sheetName}:`, err);
          if (err.result && err.result.error && err.result.error.status === 'UNAUTHENTICATED') {
             showError("Authentifizierung erforderlich oder abgelaufen. Bitte neu anmelden.", null, false);
             tokenClient.requestAccessToken({prompt: 'consent'});
         } else if (err.result && err.result.error && err.result.error.status === 'PERMISSION_DENIED') {
              showError("Keine Berechtigung zum Anhängen an die Tabelle. Stelle sicher, dass die Tabelle für dich freigegeben ist.", err);
         }
        throw err;
    }
}

// --- UI Hilfsfunktionen ---

function showLoading(message) {
    appStatus.textContent = message;
    appStatus.classList.remove('hidden');
    appStatus.classList.remove('error'); // Falls vorher Fehler angezeigt wurde
    errorMessage.classList.add('hidden');
     // Optional: Buttons deaktivieren während des Ladens
    refreshButton.disabled = true;
    document.querySelectorAll('#gruppen-liste button').forEach(b => b.disabled = true);

}

function hideLoading() {
    appStatus.classList.add('hidden');
     // Optional: Buttons wieder aktivieren
    refreshButton.disabled = false;
     document.querySelectorAll('#gruppen-liste button').forEach(b => b.disabled = false);
}

function showError(message, errorDetails = null, logError = true) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
    appStatus.classList.add('hidden'); // Verstecke Ladeanzeige
    if (errorDetails && logError) {
        console.error(message, errorDetails);
    }
}

// --- Auto-Refresh ---
let refreshIntervalId = null;
const REFRESH_INTERVAL_MS = 30000; // Alle 30 Sekunden aktualisieren

function startAutoRefresh() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId); // Alten Intervall stoppen
    }
    console.log(`Starte Auto-Refresh alle ${REFRESH_INTERVAL_MS / 1000} Sekunden.`);
    refreshIntervalId = setInterval(refreshAllData, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
     if (refreshIntervalId) {
        console.log("Stoppe Auto-Refresh.");
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
}