const uid = require('../../util/uid');
const Ev3Args = require('./ev3_args');
const Ev3Encoding = require('./ev3_encoding');
const Ev3Command = require('./ev3_command');
const Ev3Opcode = require('./ev3_opcode');

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

module.exports = EV3Motor;