pragma solidity 0.4.11;
contract Legacy {
    uint public value;
    function Legacy(uint initial) public { value = initial; }
    function() public payable { value += msg.value; }
    function fail() public { throw; }
}
