const uid = require('../../util/uid');
const BT = require('../../io/bt');
const Base64Util = require('../../util/base64-util');
const RateLimiter = require('../../util/rateLimiter.js');
const Ev3Args = require('./ev3_args');
const Ev3Encoding = require('./ev3_encoding');
const Ev3Command = require('./ev3_command');
const Ev3Opcode = require('./ev3_opcode');
const Ev3Device = require('./ev3_device');
const Ev3Mode = require('./ev3_mode');
const Ev3Label = require('./ev3_label');
const EV3Motor = require('./ev3_motor');

/**
 * String with Ev3 expected pairing pin.
 * @readonly
 */
const Ev3PairingPin = '1234';

/**
 * A maximum number of BT message sends per second, to be enforced by the rate limiter.
 * @type {number}
 */
const BTSendRateMax = 40;

class EV3 {

    constructor (runtime, extensionId) {

        /**
         * The Scratch 3.0 runtime used to trigger the green flag button.
         * @type {Runtime}
         * @private
         */
        this._runtime = runtime;
        this._runtime.on('PROJECT_STOP_ALL', this.stopAll.bind(this));

        /**
         * The id of the extension this peripheral belongs to.
         */
        this._extensionId = extensionId;

        /**
         * A list of the names of the sensors connected in ports 1,2,3,4.
         * @type {string[]}
         * @private
         */
        this._sensorPorts = [];

        /**
         * A list of the names of the motors connected in ports A,B,C,D.
         * @type {string[]}
         * @private
         */
        this._motorPorts = [];

        /**
         * The state of all sensor values.
         * @type {string[]}
         * @private
         */
        this._sensors = {
            distance: 0,
            brightness: 0,
            buttons: [0, 0, 0, 0]
        };

        /**
         * The motors which this EV3 could possibly have connected.
         * @type {string[]}
         * @private
         */
        this._motors = [null, null, null, null];

        /**
         * The polling interval, in milliseconds.
         * @type {number}
         * @private
         */
        this._pollingInterval = 150;

        /**
         * The polling interval ID.
         * @type {number}
         * @private
         */
        this._pollingIntervalID = null;

        /**
         * The counter keeping track of polling cycles.
         * @type {string[]}
         * @private
         */
        this._pollingCounter = 0;

        /**
         * The Bluetooth socket connection for reading/writing peripheral data.
         * @type {BT}
         * @private
         */
        this._bt = null;
        this._runtime.registerPeripheralExtension(extensionId, this);

        /**
         * A rate limiter utility, to help limit the rate at which we send BT messages
         * over the socket to Scratch Link to a maximum number of sends per second.
         * @type {RateLimiter}
         * @private
         */
        this._rateLimiter = new RateLimiter(BTSendRateMax);

        this.reset = this.reset.bind(this);
        this._onConnect = this._onConnect.bind(this);
        this._onMessage = this._onMessage.bind(this);
        this._pollValues = this._pollValues.bind(this);
    }

    get distance () {
        let value = this._sensors.distance > 100 ? 100 : this._sensors.distance;
        value = value < 0 ? 0 : value;
        value = Math.round(100 * value) / 100;

        return value;
    }

    get brightness () {
        return this._sensors.brightness;
    }

    /**
     * Access a particular motor on this peripheral.
     * @param {int} index - the zero-based index of the desired motor.
     * @return {EV3Motor} - the EV3Motor instance, if any, at that index.
     */
    motor (index) {
        return this._motors[index];
    }

    isButtonPressed (port) {
        return this._sensors.buttons[port] === 1;
    }

    beep (freq, time) {
        const cmd = this.generateCommand(
            Ev3Command.DIRECT_COMMAND_NO_REPLY,
            [
                Ev3Opcode.OPSOUND,
                Ev3Opcode.OPSOUND_CMD_TONE,
                Ev3Encoding.ONE_BYTE,
                2,
                Ev3Encoding.TWO_BYTES,
                freq,
                freq >> 8,
                Ev3Encoding.TWO_BYTES,
                time,
                time >> 8
            ]
        );

        this.send(cmd);
    }

    stopAll () {
        this.stopAllMotors();
        this.stopSound();
    }

    stopSound () {
        const cmd = this.generateCommand(
            Ev3Command.DIRECT_COMMAND_NO_REPLY,
            [
                Ev3Opcode.OPSOUND,
                Ev3Opcode.OPSOUND_CMD_STOP
            ]
        );

        this.send(cmd, false); // don't use rate limiter to ensure sound stops
    }

    stopAllMotors () {
        this._motors.forEach(motor => {
            if (motor) {
                motor.coast();
            }
        });
    }

    /**
     * Called by the runtime when user wants to scan for an EV3 peripheral.
     */
    scan () {
        if (this._bt) {
            this._bt.disconnect();
        }
        this._bt = new BT(this._runtime, this._extensionId, {
            majorDeviceClass: 8,
            minorDeviceClass: 1
        }, this._onConnect, this.reset, this._onMessage);
    }

    /**
     * Called by the runtime when user wants to connect to a certain EV3 peripheral.
     * @param {number} id - the id of the peripheral to connect to.
     */
    connect (id) {
        if (this._bt) {
            this._bt.connectPeripheral(id, Ev3PairingPin);
        }
    }

    /**
     * Called by the runtime when user wants to disconnect from the EV3 peripheral.
     */
    disconnect () {
        if (this._bt) {
            this._bt.disconnect();
        }

        this.reset();
    }

    /**
     * Reset all the state and timeout/interval ids.
     */
    reset () {
        this._sensorPorts = [];
        this._motorPorts = [];
        this._sensors = {
            distance: 0,
            brightness: 0,
            buttons: [0, 0, 0, 0]
        };
        this._motors = [null, null, null, null];

        if (this._pollingIntervalID) {
            window.clearInterval(this._pollingIntervalID);
            this._pollingIntervalID = null;
        }
    }

    /**
     * Called by the runtime to detect whether the EV3 peripheral is connected.
     * @return {boolean} - the connected state.
     */
    isConnected () {
        let connected = false;
        if (this._bt) {
            connected = this._bt.isConnected();
        }
        return connected;
    }

    /**
     * Send a message to the peripheral BT socket.
     * @param {Uint8Array} message - the message to send.
     * @param {boolean} [useLimiter=true] - if true, use the rate limiter
     * @return {Promise} - a promise result of the send operation.
     */
    send (message, useLimiter = true) {
        if (!this.isConnected()) return Promise.resolve();

        if (useLimiter) {
            if (!this._rateLimiter.okayToSend()) return Promise.resolve();
        }

        return this._bt.sendMessage({
            message: Base64Util.uint8ArrayToBase64(message),
            encoding: 'base64'
        });
    }

    /**
     * Genrates direct commands that are sent to the EV3 as a single or compounded byte arrays.
     * See 'EV3 Communication Developer Kit', section 4, page 24 at
     * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
     *
     * Direct commands are one of two types:
     * DIRECT_COMMAND_NO_REPLY = a direct command where no reply is expected
     * DIRECT_COMMAND_REPLY = a direct command where a reply is expected, and the
     * number and length of returned values needs to be specified.
     *
     * The direct command byte array sent takes the following format:
     * Byte 0 - 1: Command size, Little Endian. Command size not including these 2 bytes
     * Byte 2 - 3: Message counter, Little Endian. Forth running counter
     * Byte 4:     Command type. Either DIRECT_COMMAND_REPLY or DIRECT_COMMAND_NO_REPLY
     * Byte 5 - 6: Reservation (allocation) of global and local variables using a compressed format
     *             (globals reserved in byte 5 and the 2 lsb of byte 6, locals reserved in the upper
     *             6 bits of byte 6) – see documentation for more details.
     * Byte 7 - n: Byte codes as a single command or compound commands (I.e. more commands composed
     *             as a small program)
     *
     * @param {number} type - the direct command type.
     * @param {string} byteCommands - a compound array of EV3 Opcode + arguments.
     * @param {number} allocation - the allocation of global and local vars needed for replies.
     * @return {array} - generated complete command byte array, with header and compounded commands.
     */
    generateCommand (type, byteCommands, allocation = 0) {

        // Header (Bytes 0 - 6)
        let command = [];
        command[2] = 0; // Message counter unused for now
        command[3] = 0; // Message counter unused for now
        command[4] = type;
        command[5] = allocation & 0xFF;
        command[6] = allocation >> 8 && 0xFF;

        // Bytecodes (Bytes 7 - n)
        command = command.concat(byteCommands);

        // Calculate command length minus first two header bytes
        const len = command.length - 2;
        command[0] = len & 0xFF;
        command[1] = len >> 8 && 0xFF;

        return command;
    }

    /**
     * When the EV3 peripheral connects, start polling for sensor and motor values.
     * @private
     */
    _onConnect () {
        this._pollingIntervalID = window.setInterval(this._pollValues, this._pollingInterval);
    }

    /**
     * Poll the EV3 for sensor and motor input values, based on the list of
     * known connected sensors and motors. This is sent as many compound commands
     * in a direct command, with a reply expected.
     *
     * See 'EV3 Firmware Developer Kit', section 4.8, page 46, at
     * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits
     * for a list of polling/input device commands and their arguments.
     *
     * @private
     */
    _pollValues () {
        if (!this.isConnected()) {
            window.clearInterval(this._pollingIntervalID);
            return;
        }

        const cmds = []; // compound command
        let allocation = 0;
        let sensorCount = 0;

        // Reset the list of devices every 20 counts
        if (this._pollingCounter % 20 === 0) {
            // GET DEVICE LIST
            cmds[0] = Ev3Opcode.OPINPUT_DEVICE_LIST;
            cmds[1] = Ev3Encoding.ONE_BYTE;
            cmds[2] = Ev3Args.MAX_DEVICES;
            cmds[3] = Ev3Encoding.GLOBAL_VARIABLE_INDEX_0;
            cmds[4] = Ev3Encoding.GLOBAL_VARIABLE_ONE_BYTE;
            cmds[5] = Ev3Encoding.GLOBAL_CONSTANT_INDEX_0;

            // Command and payload lengths
            allocation = 33;

            this._updateDevices = true;
        } else {
            // GET SENSOR VALUES FOR CONNECTED SENSORS
            let index = 0;
            for (let i = 0; i < 4; i++) {
                if (this._sensorPorts[i] !== 'none') {
                    cmds[index + 0] = Ev3Opcode.OPINPUT_READSI;
                    cmds[index + 1] = Ev3Args.LAYER;
                    cmds[index + 2] = i; // PORT
                    cmds[index + 3] = Ev3Args.DO_NOT_CHANGE_TYPE;
                    cmds[index + 4] = Ev3Mode[this._sensorPorts[i]];
                    cmds[index + 5] = Ev3Encoding.GLOBAL_VARIABLE_ONE_BYTE;
                    cmds[index + 6] = sensorCount * 4; // GLOBAL INDEX
                    index += 7;
                }
                sensorCount++;
            }

            // GET MOTOR POSITION VALUES, EVEN IF NO MOTOR PRESENT
            for (let i = 0; i < 4; i++) {
                cmds[index + 0] = Ev3Opcode.OPOUTPUT_GET_COUNT;
                cmds[index + 1] = Ev3Args.LAYER;
                cmds[index + 2] = i; // PORT (incorrectly specified as 'Output bit field' in LEGO docs)
                cmds[index + 3] = Ev3Encoding.GLOBAL_VARIABLE_ONE_BYTE;
                cmds[index + 4] = sensorCount * 4; // GLOBAL INDEX
                index += 5;
                sensorCount++;
            }

            // Command and payload lengths
            allocation = sensorCount * 4;
        }

        const cmd = this.generateCommand(
            Ev3Command.DIRECT_COMMAND_REPLY,
            cmds,
            allocation
        );

        this.send(cmd);

        this._pollingCounter++;
    }

    /**
     * Message handler for incoming EV3 reply messages, either a list of connected
     * devices (sensors and motors) or the values of the connected sensors and motors.
     *
     * See 'EV3 Communication Developer Kit', section 4.1, page 24 at
     * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits
     * for more details on direct reply formats.
     *
     * The direct reply byte array sent takes the following format:
     * Byte 0 – 1: Reply size, Little Endian. Reply size not including these 2 bytes
     * Byte 2 – 3: Message counter, Little Endian. Equals the Direct Command
     * Byte 4:     Reply type. Either DIRECT_REPLY or DIRECT_REPLY_ERROR
     * Byte 5 - n: Resonse buffer. I.e. the content of the by the Command reserved global variables.
     *             I.e. if the command reserved 64 bytes, these bytes will be placed in the reply
     *             packet as the bytes 5 to 68.
     *
     * See 'EV3 Firmware Developer Kit', section 4.8, page 56 at
     * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits
     * for direct response buffer formats for various commands.
     *
     * @param {object} params - incoming message parameters
     * @private
     */
    _onMessage (params) {
        const message = params.message;
        const data = Base64Util.base64ToUint8Array(message);

        if (data[4] !== Ev3Command.DIRECT_REPLY) {
            return;
        }

        if (this._updateDevices) {

            // PARSE DEVICE LIST
            for (let i = 0; i < 4; i++) {
                const deviceType = Ev3Device[data[i + 5]];
                // if returned device type is null, use 'none'
                this._sensorPorts[i] = deviceType ? deviceType : 'none';
            }
            for (let i = 0; i < 4; i++) {
                const deviceType = Ev3Device[data[i + 21]];
                // if returned device type is null, use 'none'
                this._motorPorts[i] = deviceType ? deviceType : 'none';
            }
            for (let m = 0; m < 4; m++) {
                const type = this._motorPorts[m];
                if (type !== 'none' && !this._motors[m]) {
                    // add new motor if don't already have one
                    this._motors[m] = new EV3Motor(this, m, type);
                }
                if (type === 'none' && this._motors[m]) {
                    // clear old motor
                    this._motors[m] = null;
                }
            }
            this._updateDevices = false;

        // eslint-disable-next-line no-undefined
        } else if (!this._sensorPorts.includes(undefined) && !this._motorPorts.includes(undefined)) {

            // PARSE SENSOR VALUES
            let offset = 5; // start reading sensor values at byte 5
            for (let i = 0; i < 4; i++) {
                // array 2 float
                const buffer = new Uint8Array([
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3]
                ]).buffer;
                const view = new DataView(buffer);
                const value = view.getFloat32(0, true);

                if (Ev3Label[this._sensorPorts[i]] === 'button') {
                    // Read a button value per port
                    this._sensors.buttons[i] = value ? value : 0;
                } else if (Ev3Label[this._sensorPorts[i]]) { // if valid
                    // Read brightness / distance values and set to 0 if null
                    this._sensors[Ev3Label[this._sensorPorts[i]]] = value ? value : 0;
                }
                offset += 4;
            }

            // PARSE MOTOR POSITION VALUES, EVEN IF NO MOTOR PRESENT
            for (let i = 0; i < 4; i++) {
                const positionArray = [
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3]
                ];
                if (this._motors[i]) {
                    this._motors[i].position = positionArray;
                }
                offset += 4;
            }

        }
    }
}
module.exports = EV3;