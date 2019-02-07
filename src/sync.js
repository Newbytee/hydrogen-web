import {RequestAbortError} from "./hs-api.js";
import {HomeServerError, StorageError} from "./error.js";

const INCREMENTAL_TIMEOUT = 30;

function parseRooms(responseSections, roomMapper) {
	return ["join", "invite", "leave"].map(membership => {
		const membershipSection = responseSections[membership];
		const results = Object.entries(membershipSection).map(([roomId, roomResponse]) => {
			const room = roomMapper(roomId, membership);
			return room.processInitialSync(roomResponse);
		});
		return results;
	}).reduce((allResults, sectionResults) => allResults.concat(sectionResults), []);
}

export class Sync {
	constructor(hsApi, session, storage) {
		this._hsApi = hsApi;
		this._session = session;
		this._storage = storage;
		this._isSyncing = false;
		this._currentRequest = null;
	}
	// returns when initial sync is done
	async start() {
		if (this._isSyncing) {
			return;
		}
		this._isSyncing = true;
		let syncToken = session.syncToken;
		// do initial sync if needed
		if (!syncToken) {
			syncToken = await this._syncRequest();
		}
		this._syncLoop(syncToken);
	}

	async _syncLoop(syncToken) {
		// if syncToken is falsy, it will first do an initial sync ... 
		while(this._isSyncing) {
			try {
				syncToken = await this._syncRequest(INCREMENTAL_TIMEOUT, syncToken);
			} catch (err) {
				this.emit("error", err);
			}
		}
	}

	async _syncRequest(timeout, syncToken) {
		this._currentRequest = this._hsApi.sync(timeout, syncToken);
		const response = await this._currentRequest.response;
		syncToken = response.next_batch;
		const storeNames = this._storage.storeNames;
		const syncTxn = this._storage.startReadWriteTxn([
			storeNames.timeline,
			storeNames.session,
			storeNames.state
		]);
		try {
			session.applySync(syncToken, response.account_data, syncTxn);
			// to_device
			// presence
			parseRooms(response.rooms, async (roomId, roomResponse, membership) => {
				let room = session.getRoom(roomId);
				if (!room) {
					room = session.createRoom(roomId);
				}
				room.applySync(roomResponse, membership, syncTxn);
			});
		} catch(err) {
			// avoid corrupting state by only
			// storing the sync up till the point
			// the exception occurred
			txn.abort();
			throw err;
		}
		try {
			await txn.complete();
		} catch (err) {
			throw new StorageError("unable to commit sync tranaction", err);
		}
		return syncToken;
	}

	stop() {
		if (!this._isSyncing) {
			return;
		}
		this._isSyncing = false;
		if (this._currentRequest) {
			this._currentRequest.abort();
			this._currentRequest = null;
		}
	}
}