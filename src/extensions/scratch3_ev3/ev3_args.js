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

module.exports = Ev3Args;