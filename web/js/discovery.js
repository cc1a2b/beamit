// BeamIt Discovery module — WebSocket connection and peer management

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

export class SignalingClient {
    constructor(handlers) {
        this.handlers = handlers;
        this.ws = null;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.intentionallyClosed = false;
    }

    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
            return;
        }

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/ws`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this.reconnectAttempt = 0;
            this.handlers.onOpen?.();
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this._dispatch(msg);
            } catch (err) {
                console.error('Failed to parse message:', err);
            }
        };

        this.ws.onclose = (event) => {
            this.handlers.onClose?.(event);
            if (!this.intentionallyClosed) {
                this._scheduleReconnect();
            }
        };

        this.ws.onerror = (event) => {
            this.handlers.onError?.(event);
        };
    }

    disconnect() {
        this.intentionallyClosed = true;
        clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.close(1000, 'User disconnected');
            this.ws = null;
        }
    }

    send(type, data) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not connected, cannot send:', type);
            return false;
        }

        const msg = JSON.stringify({ type, data });
        this.ws.send(msg);
        return true;
    }

    get connected() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    _dispatch(msg) {
        const handler = this.handlers[`on_${msg.type}`];
        if (handler) {
            handler(msg.data);
        } else {
            console.debug('Unhandled message type:', msg.type);
        }
    }

    _scheduleReconnect() {
        const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        this.reconnectAttempt++;
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);

        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }
}
