pragma solidity 0.8.37;
interface CustomEndpoint {
    function call(bytes calldata data) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
contract BuiltinNames {
    CustomEndpoint private endpoint;
    address payable private recipient;
    function exercise() external {
        endpoint.call('');
        endpoint.transfer(address(this), 1);
        recipient.send(0);
    }
}
