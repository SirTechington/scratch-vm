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

module.exports = Ev3Mode;