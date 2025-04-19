// app_qr.js

// --- CONFIGURATION ---
// TODO: Ersetze diese Platzhalter durch deine tatsächlichen Werte
const API_KEY = 'DEIN_API_SCHLÜSSEL'; // Dein Google API Key
const CLIENT_ID = 'DEINE_CLIENT_ID.apps.googleusercontent.com'; // Deine Google OAuth 2.0 Client ID
const SPREADSHEET_ID = 'DEINE_TABELLEN_ID'; // Die ID deines Google Spreadsheets

// Namen der Tabellenblätter (Sheets)
const SHEET_NAMES = {
    TEAMS: 'Teams',
    STATIONS: 'Stationen',
    MARKET: 'Markt',
    TRANSACTIONS: 'Transaktionen',
    PURCHASES: 'KaueflicheItems' // Sheet mit kaufbaren Items und Kosten
};

// Spaltennamen (stelle sicher, dass sie mit deinem Spreadsheet übereinstimmen)
const COLS = {
    // Teams Sheet
    TEAM_ID: 'TeamID', // Eindeutige ID für jedes Team (optional, aber gut)
    CARD_IDENTIFIER: 'CardIdentifier', // Eindeutiger Wert aus dem QR-Code
    TEAM_NAME: 'TeamName',
    RESOURCES: ['Holz', 'Lehm', 'Wolle', 'Getreide', 'Erz'], // Array der Ressourcenspalten
    ITEMS: ['AnzahlDoerfer', 'AnzahlStaedte', 'Entwicklungskarten'], // Array der Item-Spalten
    LAST_CLAIM_PREFIX: 'LastClaim_', // Präfix für Cooldown-Timestamps, z.B. LastClaim_S1

    // Stations Sheet
    STATION_ID: 'StationID', // Eindeutige ID für Station (z.B. S1, S2, Holzquelle)
    STATION_NAME: 'Name',
    STATION_TYPE: 'Typ', // 'RESOURCE_CLAIM' oder 'PURCHASE'
    STATION_RESOURCES: 'Resources', // Z.B. "1 Holz, 1 Lehm"
    STATION_COOLDOWN: 'ClaimCooldownSeconds', // Cooldown in Sekunden
    STATION_PURCHASE_ITEM_ID: 'PurchaseItemID', // ID des Items, das hier gekauft werden kann (nur bei Typ PURCHASE)

    // Market Sheet (Annahme: Nur eine Zeile mit Daten)
    MARKET_ROUND: 'CurrentRound',
    MARKET_TRADE_RATIO: 'TradeRatio',

    // Purchases Sheet
    PURCHASE_ITEM_ID: 'ItemID', // Eindeutige ID des Items (z.B. 'DORF', 'STRASSE', 'EKARTE')
    PURCHASE_ITEM_NAME: 'ItemName', // Angezeigter Name (z.B. "Dorf bauen")
    PURCHASE_COST: 'Kosten', // Z.B. "1 Holz, 1 Lehm, 1 Wolle, 1 Getreide"
    PURCHASE_TARGET_COLUMN: 'ZielSpalteTeams', // Spaltenname im Teams-Sheet (z.B. AnzahlDoerfer)

    // Transactions Sheet
    TRANS_TIMESTAMP: 'Timestamp',
    TRANS_TYPE: 'Typ', // 'RESOURCE_CLAIM', 'PURCHASE', 'ERROR', 'ROUND_START', 'TRADE'
    TRANS_DEVICE_ROLE: 'GeraeteRolle',
    TRANS_TEAM_ID: 'TeamID', // (Optional) TeamID oder CardIdentifier
    TRANS_DETAILS: 'Details'
};

// Google API Scopes
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets'; // Lese- und Schreibzugriff

// --- GLOBAL STATE ---
let gapiLoaded = false;
let gisLoaded = false;
let tokenClient = null;
let currentDeviceRole = null; // { type: 'station'/'market', id: 'STATION_ID' or null }
let html5QrCode = null; // Instance of the QR Code scanner
let isScanning = false;
let currentTeamData = null; // { row: number, data: object } vom gescannten Team
let stationsData = []; // Array of station objects { StationID: ..., Name: ..., ... }
let purchaseOptions = []; // Array of purchase option objects
let marketData = null; // { round: number, ratio: string }

// --- DOM Elements ---
const screens = {
    loading: document.getElementById('loading-screen'),
    setup: document.getElementById('setup-screen'),
    station: document.getElementById('station-screen'),
    market: document.getElementById('market-screen'),
};
const loadingMessage = document.getElementById('loading-message');
const stationButtonsContainer = document.getElementById('station-buttons');
const marketButton = document.getElementById('market-button');
const setupError = document.getElementById('setup-error');
const authorizeButton = document.getElementById('authorize_button');
const signoutButton = document.getElementById('signout_button');
const marketAuthorizeButton = document.getElementById('market_authorize_button');
const marketSignoutButton = document.getElementById('market_signout_button');

// Station Screen Elements
const stationNameDisplay = document.getElementById('station-name');
const stationLogoutButton = document.getElementById('station-logout-button');
const qrReaderElement = document.getElementById('qr-reader');
const qrStatus = document.getElementById('qr-status');
const scanInterruptButton = document.getElementById('scan-interrupt-button');
const scanResumeButton = document.getElementById('scan-resume-button');
const teamInfoSection = document.getElementById('team-info');
const teamNameDisplay = document.getElementById('team-name');
const resourceList = document.getElementById('resource-list');
const itemList = document.getElementById('item-list');
const stationActionMessage = document.getElementById('station-action-message');
const purchaseMenuSection = document.getElementById('purchase-menu');
const purchaseOptionsContainer = document.getElementById('purchase-options');
const purchaseError = document.getElementById('purchase-error');
const purchaseSuccess = document.getElementById('purchase-success');
const stationFinishButton = document.getElementById('station-finish-button');
const stationError = document.getElementById('station-error');
const stationLoading = document.getElementById('station-loading');

// Market Screen Elements
const marketLogoutButton = document.getElementById('market-logout-button');
const currentRoundDisplay = document.getElementById('current-round');
const tradeRatioDisplay = document.getElementById('trade-ratio');
const refreshMarketDataButton = document.getElementById('refresh-market-data');
const nextRoundButton = document.getElementById('next-round-button');
const marketMessage = document.getElementById('market-message');
const marketError = document.getElementById('market-error');
const marketLoading = document.getElementById('market-loading');
const startTradeButton = document.getElementById('start-trade-button');
const tradeInterface = document.getElementById('trade-interface');

// --- INITIALIZATION ---

window.onload = () => {
    // Initial setup check is now deferred until GIS is loaded
    showScreen('loading');
    loadingMessage.textContent = 'Lade Google Services...';
};

function gapiLoaded() {
    gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
    try {
        await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
        });
        gapiLoaded = true;
        checkApisLoaded();
    } catch (error) {
        console.error('Fehler beim Initialisieren des GAPI Clients:', error);
        showError('setup-error', 'Fehler beim Initialisieren der Google API.');
        showScreen('setup'); // Show setup even on error to allow manual auth later?
    }
}

function gisLoaded() {
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: handleTokenResponse, // Callback wird aufgerufen, wenn Token bereit ist
        });
        gisLoaded = true;
        checkApisLoaded();
    } catch (error) {
        console.error('Fehler beim Initialisieren von GIS:', error);
        showError('setup-error', 'Fehler beim Initialisieren des Google Identity Service.');
         showScreen('setup');
    }
}

function checkApisLoaded() {
    if (gapiLoaded && gisLoaded) {
        loadingMessage.textContent = 'Prüfe Gerätestatus...';
        // Show Auth buttons in setup/market screen for manual control
        authorizeButton.style.display = 'block';
        signoutButton.style.display = 'block';
        marketAuthorizeButton.style.display = 'block';
        marketSignoutButton.style.display = 'block';
        checkDeviceRole();
    }
}

function handleTokenResponse(resp) {
    if (resp.error) {
        console.error('Google Auth Fehler:', resp.error);
        showError('setup-error', `Autorisierungsfehler: ${resp.error}. Bitte erneut versuchen.`);
        showError('market-error', `Autorisierungsfehler: ${resp.error}. Bitte erneut versuchen.`);
        // Potentiell Logout oder UI-Reset hier
        return;
    }
    console.log('Google API autorisiert.');
    // Nach erfolgreicher Autorisierung: App initialisieren
    checkDeviceRole(); // Role check führt dann zu loadInitialData etc.
}

function requestToken() {
    // Prüft, ob der Nutzer bereits eingeloggt ist/Consent gegeben hat.
    // Wenn ja, wird das Token im Hintergrund geholt und der Callback ausgelöst.
    // Wenn nein, wird der Consent-Screen angezeigt.
    tokenClient.requestAccessToken({ prompt: 'consent' }); // 'consent' erzwingt Zustimmung, 'none' versucht silent auth
}


// --- AUTHENTICATION ---

function handleAuthClick() {
    requestToken();
}

function handleSignoutClick() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token, () => {
            gapi.client.setToken('');
            console.log('Google API Token widerrufen.');
             // Update UI accordingly, maybe redirect to setup or show logged out state
             clearDeviceRole(); // Logout auch in der App erzwingen
        });
    } else {
         clearDeviceRole(); // Wenn kein Token da war, trotzdem App-Logout
    }
}

// --- DEVICE ROLE & SETUP ---

function checkDeviceRole() {
    const storedRole = localStorage.getItem('siedlerQrDeviceRole');
    if (storedRole) {
        try {
            currentDeviceRole = JSON.parse(storedRole);
            console.log('Geräterolle geladen:', currentDeviceRole);
            // Sicherstellen, dass gapi initialisiert und autorisiert ist
             if (!gapi.client.getToken()) {
                 console.log("Token fehlt, zeige Setup für Re-Auth");
                 // Zeige Buttons, aber lade keine Daten, bevor auth klappt
                 showScreen('setup');
                 // Potenziell Hinweis anzeigen, dass Autorisierung nötig ist
                 showError('setup-error', "Bitte App erneut autorisieren.");
             } else {
                loadInitialData();
             }
        } catch (e) {
            console.error("Fehler beim Parsen der Geräterolle:", e);
            localStorage.removeItem('siedlerQrDeviceRole');
            showSetupScreen();
        }
    } else {
        showSetupScreen();
    }
}

async function showSetupScreen() {
    showScreen('loading');
    loadingMessage.textContent = 'Lade Stationsdaten...';
    setupError.style.display = 'none';
    stationButtonsContainer.innerHTML = ''; // Clear old buttons

     // Authorization needed before loading stations
     if (!gapi.client.getToken()) {
        loadingMessage.textContent = 'Warte auf Autorisierung...';
        showError('setup-error', 'Bitte autorisiere die App, um Stationsdaten zu laden.');
        showScreen('setup');
        return; // Don't try to load stations yet
     }

    try {
        const response = await getSheetData(SHEET_NAMES.STATIONS, 'A:Z'); // Ganze Zeilen lesen
        stationsData = parseSheetData(response.result.values);

        stationsData.forEach(station => {
            if (station[COLS.STATION_TYPE] && station[COLS.STATION_TYPE].toUpperCase() !== 'MARKET') { // Nur Nicht-Markt Stationen
                const button = document.createElement('button');
                button.textContent = station[COLS.STATION_NAME] || `Station ${station[COLS.STATION_ID]}`;
                button.classList.add('setup-button');
                button.dataset.stationId = station[COLS.STATION_ID];
                button.addEventListener('click', () => selectDeviceRole('station', station[COLS.STATION_ID]));
                stationButtonsContainer.appendChild(button);
            }
        });
        showScreen('setup');
    } catch (error) {
        console.error('Fehler beim Laden der Stationen für Setup:', error);
        showError('setup-error', 'Fehler beim Laden der Stationsliste. Details siehe Konsole.');
        showScreen('setup'); // Show setup anyway, maybe with an error message
    }
}

function selectDeviceRole(type, id = null) {
    currentDeviceRole = { type, id };
    try {
        localStorage.setItem('siedlerQrDeviceRole', JSON.stringify(currentDeviceRole));
        console.log('Geräterolle gespeichert:', currentDeviceRole);
        loadInitialData();
    } catch (e) {
        console.error("Fehler beim Speichern der Geräterolle:", e);
         if (e.name === 'QuotaExceededError') {
             showError('setup-error', 'Speicherplatz im Browser voll (LocalStorage). Alte Daten löschen?');
         } else {
            showError('setup-error', 'Rolle konnte nicht gespeichert werden.');
         }
    }
}

function clearDeviceRole() {
    localStorage.removeItem('siedlerQrDeviceRole');
    currentDeviceRole = null;
    currentTeamData = null;
    // Ggf. Google Signout anstoßen
    // handleSignoutClick(); // -> Vorsicht, nicht in Endlosschleife geraten
    if (html5QrCode && isScanning) {
         stopQrScanner().catch(err => console.warn("Scanner konnte beim Logout nicht gestoppt werden:", err));
    }
    resetStationUI(); // Reset station UI elements
    resetMarketUI(); // Reset market UI elements
    showScreen('setup');
    console.log('Geräterolle und lokaler Status zurückgesetzt.');
     // Zeige Auth Buttons wieder an
     authorizeButton.style.display = 'block';
     signoutButton.style.display = 'block';
     marketAuthorizeButton.style.display = 'block';
     marketSignoutButton.style.display = 'block';
}

// --- DATA LOADING ---

async function loadInitialData() {
    if (!currentDeviceRole) {
        console.error("Keine Geräterolle gesetzt, Initialisierung abgebrochen.");
        showSetupScreen();
        return;
    }

    showScreen('loading');
    loadingMessage.textContent = 'Lade Spieldaten...';

     // Sicherstellen, dass auth vorhanden ist
     if (!gapi.client.getToken()) {
        console.warn("Kein Auth-Token vorhanden bei loadInitialData.");
        showScreen('setup'); // Zurück zum Setup für Auth
        showError('setup-error', 'Bitte App erneut autorisieren.');
        return;
     }

    try {
        // Lade immer Stationsdaten (nützlich für Namen etc.) und Kaufoptionen
        const stationsPromise = getSheetData(SHEET_NAMES.STATIONS, 'A:Z').then(res => {
            stationsData = parseSheetData(res.result.values);
            console.log("Stationsdaten geladen:", stationsData);
        });
        const purchasesPromise = getSheetData(SHEET_NAMES.PURCHASES, 'A:Z').then(res => {
            purchaseOptions = parseSheetData(res.result.values);
            console.log("Kaufoptionen geladen:", purchaseOptions);
        });

        await Promise.all([stationsPromise, purchasesPromise]);

        if (currentDeviceRole.type === 'station') {
            const stationInfo = getStationInfo(currentDeviceRole.id);
            if (stationInfo) {
                stationNameDisplay.textContent = stationInfo[COLS.STATION_NAME] || `Station ${currentDeviceRole.id}`;
                showScreen('station');
                resetStationUI(); // Stellt sicher, dass der Scanner startet etc.
            } else {
                throw new Error(`Stations-ID ${currentDeviceRole.id} nicht gefunden.`);
            }
        } else if (currentDeviceRole.type === 'market') {
            await fetchMarketData(); // Market Daten separat laden
            showScreen('market');
        }
    } catch (error) {
        console.error('Fehler beim Laden der Initialdaten:', error);
        showError('loading-message', 'Fehler beim Laden der Spieldaten. Details siehe Konsole.');
        // Fallback zum Setup Screen mit Fehler
        clearDeviceRole(); // Reset role if loading fails
        showError('setup-error', 'Fehler beim Initialisieren des Geräts. Bitte neu auswählen.');
    }
}

// --- GOOGLE SHEETS API WRAPPER ---

/** Hilfsfunktion zum Parsen von Sheet-Daten (Annahme: 1. Zeile ist Header) */
function parseSheetData(values) {
    if (!values || values.length < 2) return []; // Keine Daten oder nur Header
    const headers = values[0];
    return values.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            if (header) { // Nur Spalten mit Header berücksichtigen
                obj[header] = row[index];
            }
        });
        return obj;
    });
}

/** Rohdaten aus Sheet lesen */
async function getSheetData(sheetName, range) {
    console.log(`getSheetData: ${sheetName}!${range}`);
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!${range}`,
        });
        return response;
    } catch (err) {
        console.error(`Google API Fehler (getSheetData ${sheetName}!${range}):`, err);
        handleApiError(err);
        throw err; // Fehler weitergeben für spezifische Behandlung
    }
}

/** Einzelne Zeile oder Bereich aktualisieren */
async function updateSheetData(sheetName, range, values) {
     console.log(`updateSheetData: ${sheetName}!${range}`, values);
    try {
        const response = await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!${range}`,
            valueInputOption: 'USER_ENTERED', // Wichtig für Formeln/Datumsformatierung
            resource: {
                values: values // Muss ein Array von Arrays sein, z.B. [[val1, val2], [val3, val4]]
            },
        });
        return response;
    } catch (err) {
        console.error(`Google API Fehler (updateSheetData ${sheetName}!${range}):`, err);
        handleApiError(err);
        throw err;
    }
}

/** Daten an ein Sheet anhängen */
async function appendSheetData(sheetName, values) {
     console.log(`appendSheetData: ${sheetName}`, values);
    try {
        const response = await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A1`, // Startpunkt für Append
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: values // Array von Arrays, jede innere Array ist eine Zeile
            },
        });
        return response;
    } catch (err) {
        console.error(`Google API Fehler (appendSheetData ${sheetName}):`, err);
        handleApiError(err);
        throw err;
    }
}

/** Mehrere Bereiche auf einmal aktualisieren */
async function batchUpdateSheetData(data) {
    console.log('batchUpdateSheetData:', data);
     /* data format:
        [
          { range: 'Sheet!A1:B1', values: [['ValA1', 'ValB1']] },
          { range: 'Sheet!C5', values: [['ValC5']] }
        ]
     */
    try {
        const response = await gapi.client.sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                valueInputOption: 'USER_ENTERED',
                data: data
            }
        });
        return response;
    } catch (err) {
        console.error('Google API Fehler (batchUpdateSheetData):', err);
        handleApiError(err);
        throw err;
    }
}

/** Finde die Zeilennummer basierend auf einem Wert in einer bestimmten Spalte */
async function findRowByValue(sheetName, columnName, searchValue) {
    console.log(`findRowByValue: Suche "${searchValue}" in Spalte "${columnName}" in Sheet "${sheetName}"`);
    try {
        // Annahme: Spaltennamen sind in Zeile 1
        const headerResponse = await getSheetData(sheetName, '1:1');
        const headers = headerResponse.result.values ? headerResponse.result.values[0] : [];
        const columnIndex = headers.indexOf(columnName);

        if (columnIndex === -1) {
            throw new Error(`Spalte "${columnName}" nicht im Sheet "${sheetName}" gefunden.`);
        }

        const columnLetter = String.fromCharCode(65 + columnIndex); // A=0, B=1, ...
        const rangeToSearch = `${sheetName}!${columnLetter}2:${columnLetter}`; // Suche ab Zeile 2

        const dataResponse = await getSheetData(sheetName, rangeToSearch);
        const values = dataResponse.result.values || [];

        for (let i = 0; i < values.length; i++) {
            if (values[i][0] && values[i][0].toString().trim() === searchValue.toString().trim()) {
                const rowIndex = i + 2; // +1 für 0-basiert, +1 weil wir ab Zeile 2 suchen
                console.log(`Wert "${searchValue}" gefunden in Zeile ${rowIndex}`);
                return rowIndex;
            }
        }

        console.log(`Wert "${searchValue}" nicht gefunden.`);
        return null; // Nicht gefunden
    } catch (err) {
        console.error(`Fehler bei findRowByValue (${searchValue} in ${columnName}):`, err);
        // Unterscheidung, ob API-Fehler oder Spalte nicht gefunden?
        if (!err.message.includes('Spalte')) handleApiError(err);
        throw err;
    }
}

/** Grundlegende API Fehlerbehandlung */
function handleApiError(error) {
    let userMessage = 'Ein unbekannter Google API Fehler ist aufgetreten.';
    if (error.result && error.result.error) {
        const apiError = error.result.error;
        userMessage = `API Fehler: ${apiError.message} (Code: ${apiError.code}, Status: ${apiError.status})`;
        if (apiError.status === 'PERMISSION_DENIED') {
            userMessage = 'Zugriff auf Google Sheet verweigert. Berechtigungen prüfen oder neu autorisieren.';
             // Ggf. Auth Token löschen und Re-Auth erzwingen
             // gapi.client.setToken(''); // Vorsicht bei der Nutzung
             // requestToken();
        } else if (apiError.status === 'UNAUTHENTICATED') {
            userMessage = 'Nicht authentifiziert. Bitte App autorisieren.';
            // requestToken();
        } else if (apiError.code === 429) { // Quota Exceeded
            userMessage = 'API Limit erreicht. Bitte später erneut versuchen.';
        }
    } else if (error.message) {
         userMessage = `Fehler: ${error.message}`; // Netzwerkfehler etc.
    }

    console.error("handleApiError:", userMessage, error); // Logge Details für Debugging
    // Zeige Fehler im UI an (je nach Kontext)
    showError('station-error', userMessage);
    showError('market-error', userMessage);
    showError('setup-error', userMessage);
    // Logge kritische Fehler im Transaktionslog
    if (!error.message || !error.message.includes('getSheetData')) { // Nicht Lesefehler loggen?
        logTransaction('ERROR', null, `API Error: ${userMessage}`);
    }
}


// --- UTILITY FUNCTIONS ---

function showScreen(screenId) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    if (screens[screenId]) {
        screens[screenId].classList.add('active');
    } else {
        console.error("Unbekannter Screen:", screenId);
        screens.setup.classList.add('active'); // Fallback
    }
}

function showLoading(elementId, message = "Lade...") {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = message;
        element.style.display = 'block';
    }
}

function hideLoading(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.style.display = 'none';
    }
}

function showMessage(elementId, message, type = 'info') {
     const element = document.getElementById(elementId);
     if(element) {
         element.textContent = message;
         element.className = `message ${type}-message`; // type could be 'success', 'error', 'info'
         element.style.display = 'block';
         // Automatically hide after some time?
         /*
         if (type === 'success') {
             setTimeout(() => { element.style.display = 'none'; }, 5000);
         }
         */
     }
}
function showError(elementId, message) {
     const element = document.getElementById(elementId);
     if(element) {
         element.textContent = message;
         element.className = 'error-message';
         element.style.display = 'block';
     }
}
function hideMessage(elementId) {
    const element = document.getElementById(elementId);
     if(element) {
        element.style.display = 'none';
     }
}

/** Hilfsfunktion zum Parsen von Ressourcen-Strings ("1 Holz, 2 Lehm") */
function parseResourcesString(resourceString) {
    const resources = {};
    if (!resourceString || typeof resourceString !== 'string') return resources;
    const parts = resourceString.split(',');
    parts.forEach(part => {
        const match = part.trim().match(/^(\d+)\s+(.+)$/);
        if (match) {
            const amount = parseInt(match[1], 10);
            const name = match[2].trim();
            // Finde den korrekten Spaltennamen (Groß/Kleinschreibung ignorieren)
            const colName = COLS.RESOURCES.find(r => r.toLowerCase() === name.toLowerCase());
            if (colName) {
                resources[colName] = amount;
            } else {
                console.warn(`Unbekannter Ressourcenname "${name}" in String: ${resourceString}`);
            }
        }
    });
    return resources;
}

/** Formatiert Ressourcen-Objekt für die Anzeige */
function formatResources(teamDataRow) {
    return COLS.RESOURCES.map(resCol => {
        const amount = teamDataRow[resCol] || 0;
        return `<li>${resCol}: ${amount}</li>`;
    }).join('');
}

/** Formatiert Items-Objekt für die Anzeige */
function formatItems(teamDataRow) {
    return COLS.ITEMS.map(itemCol => {
         // Finde den lesbaren Namen im purchaseOptions Sheet basierend auf der Zielspalte
         const purchaseInfo = purchaseOptions.find(opt => opt[COLS.PURCHASE_TARGET_COLUMN] === itemCol);
         const itemName = purchaseInfo ? purchaseInfo[COLS.PURCHASE_ITEM_NAME] : itemCol; // Fallback auf Spaltennamen
         const amount = teamDataRow[itemCol] || 0;
        return `<li>${itemName}: ${amount}</li>`;
    }).join('');
}

/** Findet die Informationen zu einer Station anhand ihrer ID */
function getStationInfo(stationId) {
    return stationsData.find(s => s[COLS.STATION_ID] === stationId);
}

/** Loggt eine Transaktion im Spreadsheet */
async function logTransaction(type, teamIdentifier = null, details = '') {
    const timestamp = new Date().toISOString();
    const roleString = currentDeviceRole ? `${currentDeviceRole.type}${currentDeviceRole.id ? ` (${currentDeviceRole.id})` : ''}` : 'Unknown';
    const teamId = teamIdentifier || (currentTeamData ? currentTeamData.data[COLS.CARD_IDENTIFIER] : 'N/A');

    const rowData = [
        timestamp,
        type,
        roleString,
        teamId,
        details
    ];

    console.log("Logging Transaction:", rowData);

    try {
        await appendSheetData(SHEET_NAMES.TRANSACTIONS, [rowData]);
    } catch (error) {
        console.error("Fehler beim Loggen der Transaktion:", error);
        // Optional: Lokales Fallback-Logging oder erneuter Versuch?
        showError('station-error', 'Warnung: Transaktion konnte nicht geloggt werden.');
         showError('market-error', 'Warnung: Transaktion konnte nicht geloggt werden.');
    }
}


// --- QR CODE SCANNING ---

function initializeQrScanner() {
    if (html5QrCode) {
        console.log("Scanner bereits initialisiert.");
        return;
    }
     try {
        html5QrCode = new Html5Qrcode("qr-reader");
        console.log("html5-qrcode initialisiert.");
     } catch (error) {
         console.error("Fehler beim Initialisieren von html5-qrcode:", error);
         showError('station-error', 'QR Scanner konnte nicht initialisiert werden.');
         qrStatus.textContent = 'Scanner Fehler.';
     }
}

function startQrScanner() {
    if (!currentDeviceRole || currentDeviceRole.type !== 'station') return; // Nur für Stationen
     if (!html5QrCode) {
         initializeQrScanner();
         if(!html5QrCode) return; // Abbruch wenn Initialisierung fehlschlug
     }

    if (isScanning) {
        console.log("Scanner läuft bereits.");
        return;
    }

     // Verstecke Team Info und zeige Scanner Bereich
     teamInfoSection.style.display = 'none';
     purchaseMenuSection.style.display = 'none';
     stationActionMessage.style.display = 'none';
     stationFinishButton.style.display = 'none';
     hideMessage('station-error');
     hideMessage('purchase-error');
     hideMessage('purchase-success');
     qrReaderElement.style.display = 'block';
     scanInterruptButton.style.display = 'inline-block';
     scanResumeButton.style.display = 'none';


    const config = {
        fps: 10,
        qrbox: { width: 250, height: 250 }, // Anpassbare Scanbox
        aspectRatio: 1.0 // Quadratischer Scanbereich bevorzugt
    };
     const qrCodeSuccessCallback = (decodedText, decodedResult) => {
        if (isScanning) { // Nur verarbeiten, wenn aktiv gescannt wird
            console.log(`QR Code gefunden: ${decodedText}`, decodedResult);
            isScanning = false; // Stoppe weitere Verarbeitung bis UI Reset
            qrStatus.textContent = `Code erkannt: ${decodedText.substring(0, 20)}...`;
            scanInterruptButton.style.display = 'none'; // Verstecken während Verarbeitung
            stopQrScanner()
                .then(() => {
                    handleTeamScan(decodedText); // Übergib den erkannten Text
                })
                .catch(err => {
                     console.warn("Scanner konnte nach Erfolg nicht gestoppt werden:", err);
                     handleTeamScan(decodedText); // Versuche trotzdem zu verarbeiten
                 });
        }
    };
     const qrCodeErrorCallback = (errorMessage) => {
         // Oft aufgerufen, wenn kein Code gefunden wird - nur loggen bei echten Fehlern
         if (!errorMessage.includes("No QR code found")) {
            // console.warn(`QR Scanner Fehler: ${errorMessage}`);
            // qrStatus.textContent = 'Fehler beim Scannen...'; // Nicht zu aufdringlich sein
         }
     };


     // Starte den Scanner
     Html5Qrcode.getCameras().then(devices => {
         if (devices && devices.length) {
             const cameraId = devices.find(d => d.label.toLowerCase().includes('back'))?.id || devices[0].id; // Bevorzuge Rückkamera
             console.log(`Verwende Kamera: ${cameraId}`);
             qrStatus.textContent = 'Starte Kamera...';
             html5QrCode.start(
                 cameraId,
                 config,
                 qrCodeSuccessCallback,
                 qrCodeErrorCallback
             ).then(() => {
                 isScanning = true;
                 qrStatus.textContent = 'Scanne nach QR-Code...';
                 console.log("QR Scanner gestartet.");
             }).catch(err => {
                 console.error("Fehler beim Starten des Scanners:", err);
                 qrStatus.textContent = 'Kamera Fehler.';
                 showError('station-error', `Kamera konnte nicht gestartet werden: ${err.message || err}`);
                 isScanning = false;
             });
         } else {
             console.error("Keine Kameras gefunden.");
             qrStatus.textContent = 'Keine Kamera gefunden.';
              showError('station-error', 'Keine Kamera auf diesem Gerät gefunden.');
             isScanning = false;
         }
     }).catch(err => {
         console.error("Fehler beim Abrufen der Kameras:", err);
         qrStatus.textContent = 'Kamera Fehler.';
         showError('station-error', `Fehler beim Zugriff auf Kameras: ${err.message || err}`);
         isScanning = false;
     });
}

async function stopQrScanner() {
    if (html5QrCode && isScanning) {
        try {
            await html5QrCode.stop();
            console.log("QR Scanner gestoppt.");
            isScanning = false;
            qrStatus.textContent = 'Scan gestoppt.';
            scanInterruptButton.style.display = 'none';
             scanResumeButton.style.display = 'none'; // Reset both buttons
        } catch (err) {
            console.error("Fehler beim Stoppen des Scanners:", err);
            // Auch wenn Stoppen fehlschlägt, isScanning auf false setzen?
             isScanning = false; // Verhindert evtl. weitere Callbacks
            qrStatus.textContent = 'Fehler beim Stoppen.';
             throw err; // Fehler weitergeben
        }
    } else {
        // console.log("Scanner nicht aktiv oder nicht initialisiert.");
        isScanning = false; // Sicherstellen, dass der Status korrekt ist
    }
}

function interruptScan() {
     if (html5QrCode && isScanning) {
        html5QrCode.pause(true); // true = pause scanning but keep camera stream
        isScanning = false; // Temporär nicht mehr auf Codes reagieren
        qrStatus.textContent = 'Scan pausiert.';
        scanInterruptButton.style.display = 'none';
        scanResumeButton.style.display = 'inline-block';
        console.log("Scan pausiert.");
     }
}

function resumeScan() {
     if (html5QrCode) { // Keine Prüfung auf isScanning, da wir ja wieder starten wollen
        html5QrCode.resume();
        isScanning = true; // Jetzt wieder auf Codes reagieren
        qrStatus.textContent = 'Scanne nach QR-Code...';
        scanInterruptButton.style.display = 'inline-block';
        scanResumeButton.style.display = 'none';
        console.log("Scan fortgesetzt.");
     }
}

// --- STATION LOGIC ---

/** Verarbeitet den Scan eines Team-QR-Codes */
async function handleTeamScan(cardIdentifier) {
    showLoading('station-loading', 'Suche Team...');
    hideMessage('station-error');
    hideMessage('station-action-message');
    hideMessage('purchase-error');
    hideMessage('purchase-success');
    teamInfoSection.style.display = 'none';
    purchaseMenuSection.style.display = 'none';
    stationFinishButton.style.display = 'none';
    currentTeamData = null;

    try {
        const teamRowIndex = await findRowByValue(SHEET_NAMES.TEAMS, COLS.CARD_IDENTIFIER, cardIdentifier);

        if (!teamRowIndex) {
             throw new Error(`Team mit Karten-ID "${cardIdentifier}" nicht gefunden.`);
        }

        // Lade die Daten der gefundenen Zeile
        const teamDataResponse = await getSheetData(SHEET_NAMES.TEAMS, `${teamRowIndex}:${teamRowIndex}`);
        if (!teamDataResponse.result.values || teamDataResponse.result.values.length === 0) {
             throw new Error(`Daten für Team in Zeile ${teamRowIndex} konnten nicht gelesen werden.`);
        }

        // Wandle die Zeilendaten in ein Objekt um (Header benötigt)
         const headerResponse = await getSheetData(SHEET_NAMES.TEAMS, '1:1');
         const headers = headerResponse.result.values[0];
         const teamRowValues = teamDataResponse.result.values[0];
         const teamDataObject = {};
         headers.forEach((header, index) => {
             if(header) teamDataObject[header] = teamRowValues[index];
         });


        currentTeamData = {
            row: teamRowIndex,
            data: teamDataObject
        };
        console.log("Team gefunden:", currentTeamData);

        // Zeige Team Infos an
        displayTeamInfo(currentTeamData.data);
        teamInfoSection.style.display = 'block';
        hideLoading('station-loading');

        // Führe Stationsaktion aus
        const stationInfo = getStationInfo(currentDeviceRole.id);
        if (!stationInfo) throw new Error(`Stationsdaten für ${currentDeviceRole.id} nicht gefunden.`);

        const stationType = stationInfo[COLS.STATION_TYPE]?.toUpperCase();

        if (stationType === 'RESOURCE_CLAIM') {
            await handleResourceClaim(currentTeamData, stationInfo);
        } else if (stationType === 'PURCHASE') {
             // Direkt Kaufmenü anzeigen
             console.log("Zeige Kaufmenü für PURCHASE Station");
             await showPurchaseMenu(currentTeamData, stationInfo);
        } else {
            // Andere Stationstypen? Oder einfach nur Info anzeigen?
             console.warn(`Unbekannter oder keiner Stationstyp: ${stationType}`);
             stationFinishButton.style.display = 'inline-block'; // Erlaube UI Reset
        }

    } catch (error) {
        console.error('Fehler bei handleTeamScan:', error);
        showError('station-error', `Fehler: ${error.message}`);
        logTransaction('ERROR', cardIdentifier, `handleTeamScan Error: ${error.message}`);
        hideLoading('station-loading');
        // UI zurücksetzen für nächsten Scan nach Fehler
        resetStationUI();
    }
}

/** Zeigt Teamnamen, Ressourcen und Items an */
function displayTeamInfo(teamDataRow) {
    teamNameDisplay.textContent = teamDataRow[COLS.TEAM_NAME] || 'Unbekanntes Team';
    resourceList.innerHTML = formatResources(teamDataRow);
    itemList.innerHTML = formatItems(teamDataRow);
}

/** Prüft und führt Ressourcengutschrift durch */
async function handleResourceClaim(teamData, stationInfo) {
    showLoading('station-loading', 'Prüfe Cooldown...');
    const cooldownSeconds = parseInt(stationInfo[COLS.STATION_COOLDOWN] || '0', 10);
    const stationId = stationInfo[COLS.STATION_ID];
    const cooldownColumn = `${COLS.LAST_CLAIM_PREFIX}${stationId}`; // z.B. LastClaim_S1

    if (!teamData.data.hasOwnProperty(cooldownColumn)) {
         console.warn(`Cooldown-Spalte "${cooldownColumn}" nicht in Teamdaten gefunden.`);
         // Fehler anzeigen oder Cooldown ignorieren? Vorerst ignorieren.
    } else if (cooldownSeconds > 0) {
        const lastClaimTimestampStr = teamData.data[cooldownColumn];
        if (lastClaimTimestampStr) {
            try {
                const lastClaimTime = new Date(lastClaimTimestampStr).getTime();
                 const now = new Date().getTime();
                 const timePassedSeconds = (now - lastClaimTime) / 1000;

                if (timePassedSeconds < cooldownSeconds) {
                     const remainingSeconds = Math.ceil(cooldownSeconds - timePassedSeconds);
                     throw new Error(`Cooldown aktiv! Bitte warte noch ${remainingSeconds} Sekunden.`);
                }
            } catch (dateError) {
                 console.error("Fehler beim Parsen des Cooldown-Timestamps:", lastClaimTimestampStr, dateError);
                 // Was tun? Cooldown ignorieren oder Fehler anzeigen? Vorerst Fehler anzeigen.
                 throw new Error(`Ungültiger Cooldown-Zeitstempel im Sheet (${lastClaimTimestampStr}). Bitte Admin prüfen.`);
            }
        }
    }

    // Cooldown nicht aktiv oder nicht vorhanden/ignoriert -> Ressourcen gutschreiben
    showLoading('station-loading', 'Schreibe Ressourcen gut...');
    const resourcesToGrant = parseResourcesString(stationInfo[COLS.STATION_RESOURCES]);
    const resourceKeys = Object.keys(resourcesToGrant);

    if (resourceKeys.length === 0) {
        console.log("Keine Ressourcen zum Gutschreiben an dieser Station.");
         // Hier könnte direkt das Kaufmenü angezeigt werden, wenn die Station das erlaubt
         // Oder einfach nur "Fertig"
         await showPurchaseMenu(teamData, stationInfo); // Zeige Kaufmenü (falls vorhanden) auch ohne Ressourcenerhalt
        hideLoading('station-loading');
        return;
    }

    // Bereite Batch-Update vor
    const updates = [];
    const newTimestamp = new Date().toISOString();
    const headerResponse = await getSheetData(SHEET_NAMES.TEAMS, '1:1'); // Header erneut holen für Spaltenindizes
    const headers = headerResponse.result.values[0];

    // 1. Update Ressourcen
    resourceKeys.forEach(resKey => {
        const currentAmount = parseInt(teamData.data[resKey] || '0', 10);
        const grantAmount = resourcesToGrant[resKey];
        const newAmount = currentAmount + grantAmount;
        const colIndex = headers.indexOf(resKey);
        if (colIndex !== -1) {
            const range = `${SHEET_NAMES.TEAMS}!${String.fromCharCode(65 + colIndex)}${teamData.row}`;
            updates.push({ range: range, values: [[newAmount]] });
             // Update local data for immediate display (before purchase menu)
             teamData.data[resKey] = newAmount.toString();
        } else {
             console.error(`Ressourcenspalte ${resKey} nicht im Header gefunden!`);
        }
    });

    // 2. Update Cooldown Timestamp (wenn Cooldown > 0 und Spalte existiert)
     if (cooldownSeconds > 0) {
        const cooldownColIndex = headers.indexOf(cooldownColumn);
        if (cooldownColIndex !== -1) {
             const range = `${SHEET_NAMES.TEAMS}!${String.fromCharCode(65 + cooldownColIndex)}${teamData.row}`;
             updates.push({ range: range, values: [[newTimestamp]] });
             teamData.data[cooldownColumn] = newTimestamp; // Update local data
        } else {
            console.warn(`Cooldown-Spalte ${cooldownColumn} für Update nicht gefunden.`);
        }
     }

    try {
        await batchUpdateSheetData(updates);

        const successMessage = resourceKeys.map(key => `+${resourcesToGrant[key]} ${key}`).join(', ');
        showMessage('station-action-message', `${successMessage} erhalten!`, 'success');
        logTransaction('RESOURCE_CLAIM', teamData.data[COLS.CARD_IDENTIFIER], `Station: ${stationId}, Granted: ${successMessage}`);

        // Aktualisiere Anzeige mit neuen Werten
        displayTeamInfo(teamData.data); // Zeigt die (lokal) aktualisierten Werte
        hideLoading('station-loading');

        // Zeige Kaufmenü nach erfolgreicher Gutschrift
        await showPurchaseMenu(teamData, stationInfo);

    } catch (error) {
        console.error("Fehler beim Gutschreiben der Ressourcen:", error);
        showError('station-error', 'Fehler beim Speichern der neuen Ressourcen. Bitte erneut versuchen.');
        logTransaction('ERROR', teamData.data[COLS.CARD_IDENTIFIER], `RESOURCE_CLAIM Error: ${error.message}`);
        hideLoading('station-loading');
        // UI zurücksetzen, da Update fehlschlug? Oder Button lassen für Retry? Vorerst Reset.
        resetStationUI();
    }
}


/** Zeigt das Kaufmenü basierend auf Stationstyp und Teamressourcen */
async function showPurchaseMenu(teamData, stationInfo) {
    showLoading('station-loading', 'Lade Kaufoptionen...');
    hideMessage('purchase-error');
    hideMessage('purchase-success');
    purchaseOptionsContainer.innerHTML = ''; // Clear previous options

    try {
         // Lade AKTUELLE Teamdaten erneut, um sicherzustellen, dass Ressourcen aktuell sind!
         const freshTeamDataResponse = await getSheetData(SHEET_NAMES.TEAMS, `${teamData.row}:${teamData.row}`);
         if (!freshTeamDataResponse.result.values || freshTeamDataResponse.result.values.length === 0) {
             throw new Error(`Aktuelle Teamdaten für Zeile ${teamData.row} konnten nicht gelesen werden.`);
         }
         const headerResponse = await getSheetData(SHEET_NAMES.TEAMS, '1:1');
         const headers = headerResponse.result.values[0];
         const freshTeamRowValues = freshTeamDataResponse.result.values[0];
         const freshTeamDataObject = {};
         headers.forEach((header, index) => {
             if(header) freshTeamDataObject[header] = freshTeamRowValues[index];
         });
         // Aktualisiere die globalen Teamdaten mit den frischen Daten
         currentTeamData.data = freshTeamDataObject;
         displayTeamInfo(currentTeamData.data); // Update Anzeige, falls sich was geändert hat


        const stationType = stationInfo[COLS.STATION_TYPE]?.toUpperCase();
        const specificItemId = stationInfo[COLS.STATION_PURCHASE_ITEM_ID];

        let availableOptions = [];
        if (stationType === 'PURCHASE' && specificItemId) {
             // Nur das spezifische Item dieser Station anzeigen
             const item = purchaseOptions.find(opt => opt[COLS.PURCHASE_ITEM_ID] === specificItemId);
             if (item) {
                 availableOptions.push(item);
             } else {
                 console.warn(`Spezifisches Kaufitem ${specificItemId} nicht in Kaufoptionen gefunden.`);
             }
        } else {
             // Alle Kaufoptionen anzeigen (z.B. nach Ressourcenerhalt oder an "neutralen" Stationen)
             availableOptions = purchaseOptions;
        }

        if (availableOptions.length === 0) {
            console.log("Keine Kaufoptionen verfügbar/definiert.");
            purchaseMenuSection.style.display = 'none';
            stationFinishButton.style.display = 'inline-block'; // Allow closing
            hideLoading('station-loading');
            return;
        }

        availableOptions.forEach(option => {
            const button = document.createElement('button');
            const costs = parseResourcesString(option[COLS.PURCHASE_COST]);
            const costString = Object.entries(costs)
                                   .map(([res, amount]) => `${amount} ${res}`)
                                   .join(', ');

             button.classList.add('purchase-button');
             button.innerHTML = `${option[COLS.PURCHASE_ITEM_NAME] || option[COLS.PURCHASE_ITEM_ID]} <span>Kosten: ${costString || 'Keine'}</span>`;
            button.dataset.itemId = option[COLS.PURCHASE_ITEM_ID];

            // Prüfe, ob genug Ressourcen vorhanden sind
            let canAfford = true;
            for (const resource in costs) {
                const costAmount = costs[resource];
                 const teamAmount = parseInt(currentTeamData.data[resource] || '0', 10);
                if (teamAmount < costAmount) {
                    canAfford = false;
                    break;
                }
            }

            button.disabled = !canAfford;
            if (!canAfford) {
                 button.title = "Nicht genug Ressourcen.";
            }

            button.addEventListener('click', () => handlePurchase(option[COLS.PURCHASE_ITEM_ID]));
            purchaseOptionsContainer.appendChild(button);
        });

        purchaseMenuSection.style.display = 'block';
        stationFinishButton.style.display = 'inline-block'; // Allow closing
        hideLoading('station-loading');

    } catch (error) {
         console.error("Fehler beim Anzeigen des Kaufmenüs:", error);
         showError('purchase-error', `Fehler beim Laden der Kaufoptionen: ${error.message}`);
         hideLoading('station-loading');
         stationFinishButton.style.display = 'inline-block'; // Allow closing even on error
    }
}

/** Führt einen Kauf durch */
async function handlePurchase(itemId) {
    if (!currentTeamData) {
        showError('purchase-error', 'Kein Team ausgewählt.');
        return;
    }

    const itemToPurchase = purchaseOptions.find(opt => opt[COLS.PURCHASE_ITEM_ID] === itemId);
    if (!itemToPurchase) {
        showError('purchase-error', 'Kaufoption nicht gefunden.');
        return;
    }

    showLoading('station-loading', 'Prüfe Ressourcen erneut...');
    hideMessage('purchase-error');
    hideMessage('purchase-success');
    const cost = parseResourcesString(itemToPurchase[COLS.PURCHASE_COST]);
    const targetColumn = itemToPurchase[COLS.PURCHASE_TARGET_COLUMN];

    if (!targetColumn) {
         showError('purchase-error', `Zielspalte für Item ${itemId} nicht definiert.`);
         hideLoading('station-loading');
         return;
    }

    try {
        // **KRITISCH: Lade Teamdaten ERNEUT direkt vor dem Kauf!** Verhindert Race Conditions.
         const freshTeamDataResponse = await getSheetData(SHEET_NAMES.TEAMS, `${currentTeamData.row}:${currentTeamData.row}`);
         if (!freshTeamDataResponse.result.values || freshTeamDataResponse.result.values.length === 0) {
             throw new Error(`Aktuellste Teamdaten konnten nicht gelesen werden.`);
         }
         const headerResponse = await getSheetData(SHEET_NAMES.TEAMS, '1:1');
         const headers = headerResponse.result.values[0];
         const freshTeamRowValues = freshTeamDataResponse.result.values[0];
         const freshTeamDataObject = {};
         headers.forEach((header, index) => {
             if(header) freshTeamDataObject[header] = freshTeamRowValues[index];
         });
         // Verwende DIESE frischen Daten für die Prüfung
         currentTeamData.data = freshTeamDataObject; // Update global state too

        // Erneute Ressourcenprüfung
        let canAfford = true;
        for (const resource in cost) {
            const costAmount = cost[resource];
            const teamAmount = parseInt(currentTeamData.data[resource] || '0', 10);
            if (teamAmount < costAmount) {
                canAfford = false;
                break;
            }
        }

        if (!canAfford) {
             throw new Error("Nicht (mehr) genug Ressourcen für diesen Kauf.");
        }

        // Ressourcen reichen -> Bereite Batch Update vor
        showLoading('station-loading', 'Führe Kauf durch...');
        const updates = [];

        // 1. Kosten abziehen
         Object.entries(cost).forEach(([resource, amount]) => {
            const currentAmount = parseInt(currentTeamData.data[resource], 10);
            const newAmount = currentAmount - amount;
            const colIndex = headers.indexOf(resource);
            if (colIndex !== -1) {
                 const range = `${SHEET_NAMES.TEAMS}!${String.fromCharCode(65 + colIndex)}${currentTeamData.row}`;
                 updates.push({ range: range, values: [[newAmount]] });
                 // Update local data for display
                 currentTeamData.data[resource] = newAmount.toString();
            } else {
                 console.error(`Ressourcenspalte ${resource} nicht im Header gefunden für Kostenabzug.`);
            }
         });

         // 2. Item gutschreiben
         const currentItemAmount = parseInt(currentTeamData.data[targetColumn] || '0', 10);
         const newItemAmount = currentItemAmount + 1;
         const itemColIndex = headers.indexOf(targetColumn);
         if (itemColIndex !== -1) {
             const range = `${SHEET_NAMES.TEAMS}!${String.fromCharCode(65 + itemColIndex)}${currentTeamData.row}`;
             updates.push({ range: range, values: [[newItemAmount]] });
             // Update local data for display
             currentTeamData.data[targetColumn] = newItemAmount.toString();
         } else {
             console.error(`Zielspalte ${targetColumn} nicht im Header gefunden für Item-Gutschrift.`);
             // Breche Kauf ab, wenn Zielspalte fehlt? Wichtig!
             throw new Error(`Kaufziel ${targetColumn} nicht im Teamsheet gefunden! Kauf abgebrochen.`);
         }


        // Führe Batch Update aus
        await batchUpdateSheetData(updates);

        hideLoading('station-loading');
        const successMsg = `${itemToPurchase[COLS.PURCHASE_ITEM_NAME] || itemId} erfolgreich gekauft!`;
        showMessage('purchase-success', successMsg, 'success');
        logTransaction('PURCHASE', currentTeamData.data[COLS.CARD_IDENTIFIER], `Item: ${itemId} (${itemToPurchase[COLS.PURCHASE_ITEM_NAME]}), Station: ${currentDeviceRole.id}`);

        // UI aktualisieren: Teamdaten anzeigen und Kaufmenü neu rendern (Button-Status!)
        displayTeamInfo(currentTeamData.data);
        const stationInfo = getStationInfo(currentDeviceRole.id); // Station Info erneut holen
        await showPurchaseMenu(currentTeamData, stationInfo); // Erneutes Anzeigen aktualisiert Button-Status

    } catch (error) {
        console.error("Fehler beim Kauf:", error);
        showError('purchase-error', `Fehler beim Kauf: ${error.message}`);
        logTransaction('ERROR', currentTeamData.data[COLS.CARD_IDENTIFIER], `PURCHASE Error (${itemId}): ${error.message}`);
        hideLoading('station-loading');
         // Nach Fehler im Kauf: Teamdaten neu laden und Kaufmenü neu anzeigen,
         // um den korrekten Status wiederherzustellen.
         try {
             const stationInfo = getStationInfo(currentDeviceRole.id);
             await showPurchaseMenu(currentTeamData, stationInfo);
         } catch (refreshError) {
             console.error("Fehler beim Aktualisieren des Kaufmenüs nach Kauf-Fehler:", refreshError);
             // Im schlimmsten Fall UI resetten
             resetStationUI();
         }
    }
}

/** Setzt die Stations-UI zurück für den nächsten Scan */
function resetStationUI() {
     console.log("Resetting Station UI");
     currentTeamData = null;
     hideLoading('station-loading');
     hideMessage('station-error');
     hideMessage('station-action-message');
     hideMessage('purchase-error');
     hideMessage('purchase-success');
     teamInfoSection.style.display = 'none';
     purchaseMenuSection.style.display = 'none';
     stationFinishButton.style.display = 'none';
     qrReaderElement.style.display = 'block'; // Sicherstellen, dass der Reader-Bereich sichtbar ist
     qrStatus.textContent = 'Bereit für nächsten Scan.'; // Status zurücksetzen

     // Restart scanner only if the station screen is active
     if (screens.station.classList.contains('active')) {
        stopQrScanner() // Stop any previous instance cleanly
            .catch(err => console.warn("Scanner konnte beim UI Reset nicht gestoppt werden:", err))
            .finally(() => {
                // Give a slight delay before restarting, sometimes helps with camera resources
                setTimeout(startQrScanner, 100);
            });
     } else {
         isScanning = false; // Make sure scanning state is false if screen is not active
     }
}


// --- MARKET LOGIC ---

/** Lädt und zeigt Marktdaten an */
async function fetchMarketData() {
    showLoading('market-loading', 'Lade Marktdaten...');
    hideMessage('market-error');
    hideMessage('market-message');
    try {
        // Annahme: Marktdaten sind in Zeile 2 (Zeile 1 Header)
        const marketRange = `${SHEET_NAMES.MARKET}!A2:B2`; // Passe Spalten an (A=Runde, B=Ratio?)
        const response = await getSheetData(SHEET_NAMES.MARKET, marketRange);

        if (response.result.values && response.result.values.length > 0) {
             const marketRow = response.result.values[0];
             // Finde Spalten anhand der Header (flexibler)
             const headerResponse = await getSheetData(SHEET_NAMES.MARKET, '1:1');
             const headers = headerResponse.result.values[0];
             const roundIndex = headers.indexOf(COLS.MARKET_ROUND);
             const ratioIndex = headers.indexOf(COLS.MARKET_TRADE_RATIO);

             if (roundIndex === -1 || ratioIndex === -1) {
                 throw new Error("Spalten für Runde oder Handelsverhältnis im Markt-Sheet nicht gefunden.");
             }

             marketData = {
                 round: marketRow[roundIndex] || '?',
                 ratio: marketRow[ratioIndex] || '?:?',
                 roundCol: String.fromCharCode(65 + roundIndex), // Spaltenbuchstabe für Update
                 ratioCol: String.fromCharCode(65 + ratioIndex), // Spaltenbuchstabe für Update
             };
            displayMarketData();
        } else {
             throw new Error("Keine Daten im Markt-Sheet gefunden.");
        }
        hideLoading('market-loading');
    } catch (error) {
        console.error("Fehler beim Laden der Marktdaten:", error);
        showError('market-error', `Fehler beim Laden der Marktdaten: ${error.message}`);
        currentRoundDisplay.textContent = 'Fehler';
        tradeRatioDisplay.textContent = 'Fehler';
        hideLoading('market-loading');
    }
}

/** Zeigt die aktuellen Marktdaten in der UI an */
function displayMarketData() {
    if (marketData) {
        currentRoundDisplay.textContent = marketData.round;
        tradeRatioDisplay.textContent = marketData.ratio;
    } else {
        currentRoundDisplay.textContent = '?';
        tradeRatioDisplay.textContent = '?:?';
    }
}

/** Startet die nächste Runde */
async function handleNextRound() {
    if (!marketData) {
        showError('market-error', 'Marktdaten nicht geladen. Bitte zuerst aktualisieren.');
        return;
    }

    showLoading('market-loading', 'Starte nächste Runde...');
    hideMessage('market-error');
    hideMessage('market-message');

    try {
        const currentRound = parseInt(marketData.round, 10);
        const nextRound = isNaN(currentRound) ? 1 : currentRound + 1;
        const newRatio = Math.random() < 0.5 ? '1:1' : '2:1'; // Zufällige Ratio

        // Update Sheet (Annahme: Daten in Zeile 2)
        const updates = [
            { // Update Runde
                 range: `${SHEET_NAMES.MARKET}!${marketData.roundCol}2`,
                 values: [[nextRound]]
            },
            { // Update Ratio
                 range: `${SHEET_NAMES.MARKET}!${marketData.ratioCol}2`,
                 values: [[newRatio]]
            }
        ];

        await batchUpdateSheetData(updates);

        // Update lokale Daten und Anzeige
        marketData.round = nextRound.toString();
        marketData.ratio = newRatio;
        displayMarketData();

        hideLoading('market-loading');
        showMessage('market-message', `Runde ${nextRound} gestartet mit Handelsverhältnis ${newRatio}.`, 'success');
        logTransaction('ROUND_START', null, `Neue Runde: ${nextRound}, Ratio: ${newRatio}`);

    } catch (error) {
        console.error("Fehler beim Starten der nächsten Runde:", error);
        showError('market-error', `Fehler beim Starten der nächsten Runde: ${error.message}`);
        logTransaction('ERROR', null, `NEXT_ROUND Error: ${error.message}`);
        hideLoading('market-loading');
    }
}

/** Zeigt das (Platzhalter) Handel-Interface */
function handleStartTrade() {
    tradeInterface.style.display = tradeInterface.style.display === 'none' ? 'block' : 'none';
}

/** Setzt die Markt-UI zurück (z.B. bei Logout) */
function resetMarketUI() {
    marketData = null;
    displayMarketData();
    hideLoading('market-loading');
    hideMessage('market-error');
    hideMessage('market-message');
    tradeInterface.style.display = 'none';
}

// --- EVENT LISTENERS ---
marketButton.addEventListener('click', () => selectDeviceRole('market'));
stationLogoutButton.addEventListener('click', clearDeviceRole);
marketLogoutButton.addEventListener('click', clearDeviceRole);
stationFinishButton.addEventListener('click', resetStationUI);
refreshMarketDataButton.addEventListener('click', fetchMarketData);
nextRoundButton.addEventListener('click', handleNextRound);
startTradeButton.addEventListener('click', handleStartTrade);
scanInterruptButton.addEventListener('click', interruptScan);
scanResumeButton.addEventListener('click', resumeScan);
authorizeButton.addEventListener('click', handleAuthClick);
signoutButton.addEventListener('click', handleSignoutClick);
marketAuthorizeButton.addEventListener('click', handleAuthClick); // Reuse auth logic
marketSignoutButton.addEventListener('click', handleSignoutClick); // Reuse signout logic

// --- STARTUP ---
// Der Initialisierungsfluss wird jetzt durch die Google API Callbacks gesteuert (gapiLoaded, gisLoaded, checkApisLoaded)
