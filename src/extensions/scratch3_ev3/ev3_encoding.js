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

module.exports = Ev3Encoding;