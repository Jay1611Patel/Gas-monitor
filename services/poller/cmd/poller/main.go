package main

import (
	contextpkg "context"
	encodingjson "encoding/json"
	logpkg "log"
	mathbig "math/big"
	ospkg "os"
	stringspkg "strings"
	timepkg "time"

	"github.com/IBM/sarama"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/joho/godotenv"
)

func getenv(key, def string) string {
	v := ospkg.Getenv(key)
	if v == "" {
		return def
	}
	return v
}

func main() {
	_ = godotenv.Load()
	broker := getenv("KAFKA_BROKER", "kafka:9092")
	topic := getenv("KAFKA_TOPIC", "onchain-gas")
	rpcURL := getenv("ETH_RPC_URL", "")
	addrCSV := getenv("CONTRACT_ADDRESSES", "")
	tenant := getenv("TENANT_ID", "")

	if rpcURL == "" || addrCSV == "" || tenant == "" {
		logpkg.Fatal("ETH_RPC_URL, CONTRACT_ADDRESSES, TENANT_ID are required")
	}

	targets := make(map[string]bool)
	for _, a := range stringspkg.Split(addrCSV, ",") {
		if a == "" {
			continue
		}
		targets[stringspkg.ToLower(a)] = true
	}

	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		logpkg.Fatalf("dial rpc: %v", err)
	}
	defer client.Close()

	cfg := sarama.NewConfig()
	cfg.Producer.Return.Successes = true
	producer, err := sarama.NewSyncProducer([]string{broker}, cfg)
	if err != nil {
		logpkg.Fatalf("kafka producer: %v", err)
	}
	defer producer.Close()

	ctx := contextpkg.Background()
	// initialize last to current head on start to avoid backfill
	head, err := client.BlockByNumber(ctx, nil)
	if err != nil {
		logpkg.Fatalf("get head: %v", err)
	}
	last := head.Number().Uint64()

	for {
		head, err := client.BlockByNumber(ctx, nil)
		if err != nil {
			logpkg.Printf("block err: %v", err)
			timepkg.Sleep(3 * timepkg.Second)
			continue
		}
		if head.Number().Uint64() <= last {
			timepkg.Sleep(2 * timepkg.Second)
			continue
		}
		for bn := last + 1; bn <= head.Number().Uint64(); bn++ {
			blk, err := client.BlockByNumber(ctx, mathbig.NewInt(int64(bn)))
			if err != nil {
				logpkg.Printf("block %d err: %v", bn, err)
				continue
			}
			for _, tx := range blk.Transactions() {
				if tx.To() == nil { // contract creation
					continue
				}
				to := stringspkg.ToLower(tx.To().Hex())
				if !targets[to] {
					continue
				}
				rec, err := client.TransactionReceipt(ctx, tx.Hash())
				if err != nil {
					continue
				}
				payload := map[string]any{
					"tenantId": tenant,
					"contract": to,
					"txHash": tx.Hash().Hex(),
					"blockNumber": blk.Number().Uint64(),
					"gasUsed": rec.GasUsed,
				}
				value, _ := encodingjson.Marshal(payload)
				msg := &sarama.ProducerMessage{Topic: topic, Value: sarama.ByteEncoder(value)}
				_, _, _ = producer.SendMessage(msg)
			}
		}
		last = head.NumberU64()
	}
}