import os
import time
import sys

# Paths for communication
INPUT_FILE = "bridge_input.txt"
OUTPUT_FILE = "bridge_output.txt"

def main():
    # Clear files on start
    with open(INPUT_FILE, "w") as f: f.write("")
    with open(OUTPUT_FILE, "w") as f: f.write("")

    print("\033[92m" + "="*50)
    print("      DEVSWAT LIVE TERMINAL BRIDGE ACTIVE")
    print("="*50 + "\033[0m")
    print("Type your message below. I will respond here.")
    
    while True:
        try:
            user_input = input("\033[94mYou > \033[0m")
            if user_input.lower() in ["exit", "quit"]:
                print("Closing bridge...")
                break
            
            # Write user input for AI to read
            with open(INPUT_FILE, "w") as f:
                f.write(user_input)
            
            print("\033[90m(AI is thinking...)\033[0m")
            
            # Wait for AI response
            response_received = False
            while not response_received:
                if os.path.exists(OUTPUT_FILE) and os.path.getsize(OUTPUT_FILE) > 0:
                    with open(OUTPUT_FILE, "r") as f:
                        response = f.read()
                    
                    print(f"\n\033[95mDevSwat >\033[0m {response}\n")
                    
                    # Clear output file to wait for next one
                    with open(OUTPUT_FILE, "w") as f: f.write("")
                    response_received = True
                time.sleep(0.5)
                
        except KeyboardInterrupt:
            break

if __name__ == "__main__":
    main()
