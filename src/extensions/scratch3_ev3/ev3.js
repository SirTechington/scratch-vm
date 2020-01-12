const uid = require('../../util/uid');
const BT = require('../../io/bt');
const Base64Util = require('../../util/base64-util');
const RateLimiter = require('../../util/rateLimiter.js');

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

/**
 * Enum for Ev3 parameter encodings of various argument and return values.
 * Found in the 'EV3 Firmware Developer Kit', section4, page 9, at
 * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
 *
 * The format for these values is:
 * 0xxxxxxx for Short Format
 * 1ttt-bbb for Long Format
 *
 * @readonly
 * @enum {number}
 */
const Ev3Encoding = {
    ONE_BYTE: 0x81, // = 0b1000-001, "1 byte to follow"
    TWO_BYTES: 0x82, // = 0b1000-010, "2 bytes to follow"
    FOUR_BYTES: 0x83, // = 0b1000-011, "4 bytes to follow"
    GLOBAL_VARIABLE_ONE_BYTE: 0xE1, // = 0b1110-001, "1 byte to follow"
    GLOBAL_CONSTANT_INDEX_0: 0x20, // = 0b00100000
    GLOBAL_VARIABLE_INDEX_0: 0x60 // = 0b01100000
};

/**
 * Enum for Ev3 direct command types.
 * Found in the 'EV3 Communication Developer Kit', section 4, page 24, at
 * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
 * @readonly
 * @enum {number}
 */
const Ev3Command = {
    DIRECT_COMMAND_REPLY: 0x00,
    DIRECT_COMMAND_NO_REPLY: 0x80,
    DIRECT_REPLY: 0x02
};

/**
 * Enum for Ev3 commands opcodes.
 * Found in the 'EV3 Firmware Developer Kit', section 4, page 10, at
 * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
 * @readonly
 * @enum {number}
 */
const Ev3Opcode = {
    OPOUTPUT_STEP_SPEED: 0xAE,
    OPOUTPUT_TIME_SPEED: 0xAF,
    OPOUTPUT_STOP: 0xA3,
    OPOUTPUT_RESET: 0xA2,
    OPOUTPUT_STEP_SYNC: 0xB0,
    OPOUTPUT_TIME_SYNC: 0xB1,
    OPOUTPUT_GET_COUNT: 0xB3,
    OPSOUND: 0x94,
    OPSOUND_CMD_TONE: 1,
    OPSOUND_CMD_STOP: 0,
    OPINPUT_DEVICE_LIST: 0x98,
    OPINPUT_READSI: 0x9D
};

/**
 * Enum for Ev3 values used as arguments to various opcodes.
 * Found in the 'EV3 Firmware Developer Kit', section4, page 10-onwards, at
 * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
 * @readonly
 * @enum {number}
 */
const Ev3Args = {
    LAYER: 0, // always 0, chained EV3s not supported
    COAST: 0,
    BRAKE: 1,
    RAMP: 50, // time in milliseconds
    DO_NOT_CHANGE_TYPE: 0,
    MAX_DEVICES: 32 // 'Normally 32' from pg. 46
};

/**
 * Enum for Ev3 device type numbers.
 * Found in the 'EV3 Firmware Developer Kit', section 5, page 100, at
 * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
 * @readonly
 * @enum {string}
 */
const Ev3Device = {
    29: 'color',
    30: 'ultrasonic',
    32: 'gyro',
    16: 'touch',
    8: 'mediumMotor',
    7: 'largeMotor',
    126: 'none',
    125: 'none'
};

/**
 * Enum for Ev3 device modes.
 * Found in the 'EV3 Firmware Developer Kit', section 5, page 100, at
 * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
 * @readonly
 * @enum {number}
 */
const Ev3Mode = {
    touch: 0, // touch
    color: 1, // ambient
    ultrasonic: 1, // inch
    none: 0
};

/**
 * Enum for Ev3 device labels used in the Scratch blocks/UI.
 * @readonly
 * @enum {string}
 */
const Ev3Label = {
    touch: 'button',
    color: 'brightness',
    ultrasonic: 'distance'
};

/**
 * Manage power, direction, and timers for one EV3 motor.
 */
class EV3Motor {

    /**
     * Construct a EV3 Motor instance, which could be of type 'largeMotor' or
     * 'mediumMotor'.
     *
     * @param {EV3} parent - the EV3 peripheral which owns this motor.
     * @param {int} index - the zero-based index of this motor on its parent peripheral.
     * @param {string} type - the type of motor (i.e. 'largeMotor' or 'mediumMotor').
     */
    constructor (parent, index, type) {
        /**
         * The EV3 peripheral which owns this motor.
         * @type {EV3}
         * @private
         */
        this._parent = parent;

        /**
         * The zero-based index of this motor on its parent peripheral.
         * @type {int}
         * @private
         */
        this._index = index;

        /**
         * The type of EV3 motor this could be: 'largeMotor' or 'mediumMotor'.
         * @type {string}
         * @private
         */
        this._type = type;

        /**
         * This motor's current direction: 1 for "clockwise" or -1 for "counterclockwise"
         * @type {number}
         * @private
         */
        this._direction = 1;

        /**
         * This motor's current power level, in the range [0,100].
         * @type {number}
         * @private
         */
        this._power = 50;

        /**
         * This motor's current position, in the range [0,360].
         * @type {number}
         * @private
         */
        this._position = 0;

        /**
         * An ID for the current coast command, to help override multiple coast
         * commands sent in succession.
         * @type {number}
         * @private
         */
        this._commandID = null;

        /**
         * A delay, in milliseconds, to add to coasting, to make sure that a brake
         * first takes effect if one was sent.
         * @type {number}
         * @private
         */
        this._coastDelay = 1000;
    }

    /**
     * @return {string} - this motor's type: 'largeMotor' or 'mediumMotor'
     */
    get type () {
        return this._type;
    }

    /**
     * @param {string} value - this motor's new type: 'largeMotor' or 'mediumMotor'
     */
    set type (value) {
        this._type = value;
    }

    /**
     * @return {int} - this motor's current direction: 1 for "clockwise" or -1 for "counterclockwise"
     */
    get direction () {
        return this._direction;
    }

    /**
     * @param {int} value - this motor's new direction: 1 for "clockwise" or -1 for "counterclockwise"
     */
    set direction (value) {
        if (value < 0) {
            this._direction = -1;
        } else {
            this._direction = 1;
        }
    }

    /**
     * @return {int} - this motor's current power level, in the range [0,100].
     */
    get power () {
        return this._power;
    }

    /**
     * @param {int} value - this motor's new power level, in the range [0,100].
     */
    set power (value) {
        this._power = value;
    }

    /**
     * @return {int} - this motor's current position, in the range [-inf,inf].
     */
    get position () {
        return this._position;
    }

    /**
     * @param {int} array - this motor's new position, in the range [0,360].
     */
    set position (array) {
        // tachoValue from Paula
        let value = array[0] + (array[1] * 256) + (array[2] * 256 * 256) + (array[3] * 256 * 256 * 256);
        if (value > 0x7fffffff) {
            value = value - 0x100000000;
        }
        this._position = value;
    }

    /**
     * Turn this motor on for a specific duration.
     * Found in the 'EV3 Firmware Developer Kit', page 56, at
     * https://education.lego.com/en-us/support/mindstorms-ev3/developer-kits.
     *
     * Opcode arguments:
     * (Data8) LAYER – Specify chain layer number [0 - 3]
     * (Data8) NOS – Output bit field [0x00 – 0x0F]
     * (Data8) SPEED – Power level, [-100 – 100]
     * (Data32) STEP1 – Time in milliseconds for ramp up
     * (Data32) STEP2 – Time in milliseconds for continues run
     * (Data32) STEP3 – Time in milliseconds for ramp down
     * (Data8) BRAKE - Specify break level [0: Float, 1: Break]
     *
     * @param {number} milliseconds - run the motor for this long.
     */
    turnOnFor (milliseconds) {
        if (this._power === 0) return;

        const port = this._portMask(this._index);
        let n = milliseconds;
        let speed = this._power * this._direction;
        const ramp = Ev3Args.RAMP;

        let byteCommand = [];
        byteCommand[0] = Ev3Opcode.OPOUTPUT_TIME_SPEED;

        // If speed is less than zero, make it positive and multiply the input
        // value by -1
        if (speed < 0) {
            speed = -1 * speed;
            n = -1 * n;
        }
        // If the input value is less than 0
        const dir = (n < 0) ? 0x100 - speed : speed; // step negative or positive
        n = Math.abs(n);
        // Setup motor run duration and ramping behavior
        let rampup = ramp;
        let rampdown = ramp;
        let run = n - (ramp * 2);
        if (run < 0) {
            rampup = Math.floor(n / 2);
            run = 0;
            rampdown = n - rampup;
        }
        // Generate motor command values
        const runcmd = this._runValues(run);
        byteCommand = byteCommand.concat([
            Ev3Args.LAYER,
            port,
            Ev3Encoding.ONE_BYTE,
            dir & 0xff,
            Ev3Encoding.ONE_BYTE,
            rampup
        ]).concat(runcmd.concat([
            Ev3Encoding.ONE_BYTE,
            rampdown,
            Ev3Args.BRAKE
        ]));

        const cmd = this._parent.generateCommand(
            Ev3Command.DIRECT_COMMAND_NO_REPLY,
            byteCommand
        );

        this._parent.send(cmd);

        this.coastAfter(milliseconds);
    }

    /**
     * Set the motor to coast after a specified amount of time.
     * @param {number} time - the time in milliseconds.
     */
    coastAfter (time) {
        if (this._power === 0) return;

        // Set the motor command id to check before starting coast
        const commandId = uid();
        this._commandID = commandId;

        // Send coast message
        setTimeout(() => {
            // Do not send coast if another motor command changed the command id.
            if (this._commandID === commandId) {
                this.coast();
                this._commandID = null;
            }
        }, time + this._coastDelay); // add a delay so the brake takes effect
    }

    /**
     * Set the motor to coast.
     */
    coast () {
        if (this._power === 0) return;

        const cmd = this._parent.generateCommand(
            Ev3Command.DIRECT_COMMAND_NO_REPLY,
            [
                Ev3Opcode.OPOUTPUT_STOP,
                Ev3Args.LAYER,
                this._portMask(this._index), // port output bit field
                Ev3Args.COAST
            ]
        );

        this._parent.send(cmd, false); // don't use rate limiter to ensure motor stops
    }

    /**
     * Generate motor run values for a given input.
     * @param  {number} run - run input.
     * @return {array} - run values as a byte array.
     */
    _runValues (run) {
        // If run duration is less than max 16-bit integer
        if (run < 0x7fff) {
            return [
                Ev3Encoding.TWO_BYTES,
                run & 0xff,
                (run >> 8) & 0xff
            ];
        }

        // Run forever
        return [
            Ev3Encoding.FOUR_BYTES,
            run & 0xff,
            (run >> 8) & 0xff,
            (run >> 16) & 0xff,
            (run >> 24) & 0xff
        ];
    }

    /**
     * Return a port value for the EV3 that is in the format for 'output bit field'
     * as 1/2/4/8, generally needed for motor ports, instead of the typical 0/1/2/3.
     * The documentation in the 'EV3 Firmware Developer Kit' for motor port arguments
     * is sometimes mistaken, but we believe motor ports are mostly addressed this way.
     * @param {number} port - the port number to convert to an 'output bit field'.
     * @return {number} - the converted port number.
     */
    _portMask (port) {
        return Math.pow(2, port);
    }
}

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