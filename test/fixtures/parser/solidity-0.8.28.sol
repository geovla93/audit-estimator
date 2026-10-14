pragma solidity 0.8.28;
contract TransientStorage {
    uint transient internal lock;
    function enter() internal { lock = 1; }
}
