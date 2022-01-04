import * as React from 'react';
import * as ReactDOM from "react-dom"
import * as RB from "react-bootstrap"
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { v4 as uuidv4 } from 'uuid';
import { observer } from "mobx-react";

type UserRole = "Voter" | "Watcher";

interface UserMessage {
    user_name: string,
    role: UserRole,
}

interface ConfigMessage {
    vote_options: number[],
    owner: string,
    me: string,
    room_creation_time: string
}

interface UserUpdateMessage {
    pub_user_uuid: string,
    user_name: string,
    role: UserRole,
    is_this: boolean,
    is_active: boolean,
}

interface UsersUpdateMessage {
    users: UserUpdateMessage[]
}

type Vote = {Value: number} | "Coffee" | "Question" | "Hidden"

function eqVote(e1: Vote, e2: Vote) {
    if (e1 === "Coffee" && e2 === "Coffee")
        return true;

    if (e1 === "Question" && e2 === "Question")
        return true;

    if (typeof e1 == "object" && "Value" in e1 && typeof e2 == "object" && "Value" in e2)
        return e1.Value == e2.Value;

    return false;
}

interface StoryItem {
    story_url: string,
    story_description: string
}

interface AddStoriesMessage {
    stories: StoryItem[]
}

type StoryState = "Voting" | "Flipped" | "Finished";
interface StoryUpdateMessage {
    story_uuid: string,
    story: StoryItem,
    state: StoryState,
    votes: {[key: string] : Vote},
    final_vote?: number,
}

interface StoriesUpdateMessage {
    stories: StoryUpdateMessage[],
    active_story: string,
}

interface SetActiveStoryMessage {
    story_uuid: string
}

interface VoteMessage {
    story_uuid: string;
    vote: Vote;
}

interface FinishVotingMessage {
    story_uuid: string;
    final_vote: number;
}

interface RemoveStoryMessage {
    story_uuid: string;
}

interface ForceFlipMessage {
    story_uuid: string;
}

interface SetActiveStoryMessage {
    story_uuid: string;
}

interface LocalStorageConfig {
    userName: string,
    userUuid: string,
    role?: UserRole
}

const LOCAL_STORAGE_KEY = "ud1_poker_state";

function updateQueryStringParameter(uri: string, key: string, value: string) {
    var re = new RegExp("([?&])" + key + "=.*?(&|$)", "i");
    var separator = uri.indexOf('?') !== -1 ? "&" : "?";
    if (uri.match(re)) {
        return uri.replace(re, '$1' + key + "=" + encodeURIComponent(value) + '$2');
    }
    else {
        return uri + separator + key + "=" + encodeURIComponent(value);
    }
}

function getUrlStringParameter(key: string) {
    let uri = window.location.href;
    let fragmentPos = uri.indexOf("#");
    if (fragmentPos >= 0) {
        uri = uri.substring(0, fragmentPos);
    }
    let re = new RegExp("([?&])" + key + "=(.*?)(&|$)", "i");
    let match = re.exec(uri);
    if (match) {
        return decodeURIComponent(match[2]);
    } else {
        return null;
    }
}

const URL_ROOM_ID = "roomId";

class State {
    constructor() {
        makeObservable(this);

        runInAction(() => {
            let config = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (!config) {
                this.userUuid = uuidv4();
                this.userNameInput = true;
                this.saveConfig();
            }
            else {
                let parsedConfig = JSON.parse(config) as LocalStorageConfig;
                this.userUuid = parsedConfig.userUuid;
                this.userName = parsedConfig.userName;
                this.role = parsedConfig.role || "Voter";
            }

            if (this.userName) {
                this.connect();
            } else {
                this.userNameInput = true;
            }
        });
    }

    saveConfig() {
        let config:LocalStorageConfig = {
            userUuid: this.userUuid,
            userName: this.userName,
            role: this.role
        }

        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(config));
    }

    connect() {
        let userUuid = this.userUuid;
        let roomUuid = getUrlStringParameter(URL_ROOM_ID);
        if (!roomUuid) {
            roomUuid = uuidv4();
            let newUrl = updateQueryStringParameter(window.location.href, URL_ROOM_ID, roomUuid);
            history.replaceState(null, '', newUrl);
        }

        var ws = new WebSocket(`ws://${window.location.host}/ws/${userUuid}/${roomUuid}`);
        ws.onopen = () => this.sendUserMessage();

        ws.onclose = (e) => {
            console.log('Socket is closed. Reconnect will be attempted in 1 second.', e.reason);
            setTimeout(() => this.connect(), 1000);
        };

        ws.onerror = (err) => {
            console.error('Socket encountered error: ', err, 'Closing socket');
            ws.close();
        };

        ws.onmessage = (e) => {
            console.log('Message:', e.data);

            if (typeof e.data == "string") {
                runInAction(() => {
                    if (e.data.startsWith("config ")) {
                        let message = JSON.parse(e.data.substring("config ".length)) as ConfigMessage;
                        
                        this.vote_options = message.vote_options;
                        this.owner = message.owner;
                        this.pubUserUuid = message.me;
                        this.roomCreationTime = message.room_creation_time;
                    }
                    else if (e.data.startsWith("users ")) {
                        let message = JSON.parse(e.data.substring("users ".length)) as UsersUpdateMessage;
                        this.users = message.users;
                    }
                    else if (e.data.startsWith("stories ")) {
                        let message = JSON.parse(e.data.substring("stories ".length)) as StoriesUpdateMessage;
                        this.stories = message.stories;
                        if (message.active_story && this.ownerActiveStory != message.active_story) {
                            this.ownerActiveStory = message.active_story;
                            this.myActiveStory = message.active_story;
                        }
                    }
                });
            }
        };

        this.ws = ws;
    }

    sendUserMessage() {
        let userMessage: UserMessage = {
            user_name: this.userName,
            role: this.role
        }
        this.ws?.send("user " + JSON.stringify(userMessage));
    }

    @action.bound
    onUserNameEntered() {
        if (this.userName) {
            this.userNameInput = false;
            this.saveConfig();
            if (!this.ws) {
                this.connect();
            }
            else {
                this.sendUserMessage();
            }
        }
    }

    @action.bound
    setUserName(userName: string) {
        this.userName = userName;
    }

    @action.bound
    setRole(role: UserRole) {
        this.role = role;
    }

    @action.bound
    setStoriesRawString(storiesRawString: string) {
        this.storiesRawString = storiesRawString;
    }

    @action.bound
    onStoriesEntered() {
        this.addStoriesInput = false;

        if (this.parsedStories.length) {
            let message: AddStoriesMessage = {
                stories: this.parsedStories
            }

            this.ws?.send("stories " + JSON.stringify(message));
        }

        this.storiesRawString = "";
    }

    @action.bound
    hideAddStories() {
        this.addStoriesInput = false;
    }

    @action.bound
    selectMyActiveStory(myActiveStory: string) {
        this.myActiveStory = myActiveStory;
    }

    ws: WebSocket | null = null;

    @computed
    get activeStory() {
        return this.stories.find(s => s.story_uuid == this.myActiveStory);
    }

    @computed
    get mean() {
        let activeStory = this.activeStory;
        if (!activeStory)
            return null;

        let sum = 0;
        let num = 0;
        for (let k of Object.keys(activeStory.votes)) {
            let vote = activeStory.votes[k];
            if (typeof vote == "object") {
                sum += vote.Value * vote.Value;
                num++;
            }
        }

        if (num == 0)
            return null;

        let result = Math.sqrt(sum / num);
        return Math.round(result * 10) / 10;
    }

    @computed
    get anyHiddenVote() {
        let activeStory = this.activeStory;
        if (!activeStory)
            return false;

        for (let k of Object.keys(activeStory.votes)) {
            let vote = activeStory.votes[k];
            if (vote == "Hidden") {
                return true;
            }
        }

        return false;
    }

    @computed
    get selectedVote() {
        return this.activeStory?.votes[this.pubUserUuid]
    }

    selectVote(vote : Vote) {
        let message: VoteMessage = {
            story_uuid: this.myActiveStory,
            vote: vote
        }

        if (this.ws) {
            this.ws.send("vote " + JSON.stringify(message));
        }
    }

    @action.bound
    finishVoting() {
        if (this.ws && this.myActiveStory) {
            let message: FinishVotingMessage = {
                story_uuid: this.myActiveStory,
                final_vote: +this.finalVoteText
            }

            this.finalVoteText = "";

            this.ws.send("finish " + JSON.stringify(message));
        }
    }

    deleteStory() {
        if (this.ws && this.myActiveStory) {
            let message: RemoveStoryMessage = {
                story_uuid: this.myActiveStory
            }

            this.ws.send("remove_story " + JSON.stringify(message));
        }
    }

    forceFlip() {
        if (this.ws && this.myActiveStory) {
            let message: ForceFlipMessage = {
                story_uuid: this.myActiveStory
            }

            this.ws.send("flip " + JSON.stringify(message));
        }
    }

    setActive() {
        if (this.ws && this.myActiveStory) {
            let message: SetActiveStoryMessage = {
                story_uuid: this.myActiveStory
            }

            this.ws.send("active_story " + JSON.stringify(message));
        }
    }

    @computed
    get parsedStories(): StoryItem[] {
        let result = new Array<StoryItem>();

        let chunks = this.storiesRawString.split(/\s+/);

        let item: StoryItem | null = null;
        for (let chunk of chunks) {
            if (chunk.startsWith("https://") || chunk.startsWith("http://")) {
                if (item) {
                    result.push(item);
                }

                item = {
                    story_url: chunk,
                    story_description: ""
                }
            }
            else if (item) {
                item.story_description += chunk + " ";
            }
        }

        if (item)
            result.push(item);

        return result;
    }

    @action.bound
    openAddStoriesDialog() {
        this.addStoriesInput = true;
    }

    @action.bound
    enterUserNameAndRoleDialog() {
        this.userNameInput = true;
    }

    @action.bound
    setFinalVoteText(finalVoteText: string) {
        if (!isNaN(+finalVoteText)) {
            this.finalVoteText = finalVoteText;
        }
    }
    
    @observable userNameInput = false;
    @observable addStoriesInput = false;
    @observable userName: string = "";
    @observable userUuid: string = "";
    @observable pubUserUuid: string = "";
    @observable vote_options: number[] = [];
    @observable owner = ""
    @observable users: UserUpdateMessage[] = [];
    @observable stories: StoryUpdateMessage[] = [];
    @observable ownerActiveStory: string | null = null;
    @observable myActiveStory: string = "";
    @observable role: UserRole = "Voter";
    @observable roomCreationTime = ""
    @observable finalVoteText = ""

    @observable storiesRawString: string = "";
}

@observer
class EnterUserNameDialog extends React.Component<{state: State}> {
    onUserNameChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
        this.props.state.setUserName(ev.target.value);
    }
    onRoleChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
        this.props.state.setRole(ev.currentTarget.value as UserRole);
    }
    render() {
        let state = this.props.state;

        return <RB.Modal show={state.userNameInput} onHide={state.onUserNameEntered}>
            <RB.Modal.Header closeButton>
                <RB.Modal.Title>Enter user name</RB.Modal.Title>
            </RB.Modal.Header>

            <RB.Modal.Body>
                <RB.Form onSubmit={state.onUserNameEntered}>
                    <RB.Form.Group className="mb-3" controlId="userName">
                        <RB.Form.Label>User name</RB.Form.Label>
                        <RB.Form.Control type="text" placeholder="Enter user name" value={state.userName} onChange={this.onUserNameChange}/>
                    </RB.Form.Group>
                    <RB.ButtonGroup>
                        <RB.ToggleButton id="userRoleVoter" type="radio" name="userRole" value="Voter" checked={state.role == "Voter"} onChange={this.onRoleChange}>
                            Voter
                        </RB.ToggleButton>
                        <RB.ToggleButton id="userRoleWatcher" type="radio" name="userRole" value="Watcher" checked={state.role == "Watcher"} onChange={this.onRoleChange}>
                            Watcher
                        </RB.ToggleButton>
                    </RB.ButtonGroup>
                </RB.Form>
            </RB.Modal.Body>
        </RB.Modal>
    }
}

@observer
class AddStoriesDialog extends React.Component<{state: State}> {
    onChange = (ev: React.ChangeEvent<HTMLTextAreaElement>) => {
        this.props.state.setStoriesRawString(ev.target.value);
    }

    render() {
        let state = this.props.state;

        return <RB.Modal size="lg" show={state.addStoriesInput} onHide={state.hideAddStories}>
            <RB.Modal.Header closeButton>
                <RB.Modal.Title>Add stories</RB.Modal.Title>
            </RB.Modal.Header>

            <RB.Modal.Body>
                <RB.Form>
                    <RB.Form.Group className="mb-3" controlId="userName">
                        <RB.Form.Label>Stories</RB.Form.Label>
                        <RB.Form.Control as="textarea" rows={15} placeholder="Enter stories" value={state.storiesRawString} onChange={this.onChange} />
                    </RB.Form.Group>

                    <RB.ListGroup variant="flush">
                        {state.parsedStories.map((s, i) => <RB.ListGroup.Item key={i}>
                                <a href={s.story_url || "#"} target="_blank">
                                    {s.story_url}
                                </a>
                                {' '}
                                {s.story_description || ''}
                            </RB.ListGroup.Item>)
                        }
                    </RB.ListGroup>

                    <RB.Button onClick={state.onStoriesEntered}>Add</RB.Button>
                </RB.Form>
            </RB.Modal.Body>
        </RB.Modal>
    }
}

function renderVote(vote : Vote) {
    if (typeof vote == "object" && "Value" in vote)
        return "" + vote.Value;

    if ("Coffee" === vote)
        return "(°_°)";

    if ("Question" === vote)
        return "?";

    return "*";
}

@observer
class VoteOption extends React.Component<{state: State, vote : Vote}> {
    render() {
        let state = this.props.state;
        let disabled = state.activeStory == null || state.activeStory.state == "Finished";
        let selected = state.selectedVote != null && eqVote(state.selectedVote, this.props.vote);

        return <RB.Card bg={selected ? 'success' : ''} text={selected ? 'white' : undefined}
            className="text-center p-0 mx-1" onClick={disabled ? undefined : () => state.selectVote(this.props.vote)}>
            <RB.Card.Body className={`p-2 ${disabled && !selected ? "text-muted" : ""}`} role={disabled ? undefined : "button"}>
                {renderVote(this.props.vote)}
            </RB.Card.Body>
        </RB.Card>
    }
}

@observer
class VoteCards extends React.Component<{state: State}> {
    render() {
        let state = this.props.state;
        let story = state.activeStory;
        let ownerActive = story && state.ownerActiveStory == story.story_uuid;
        let finished = story && story.state == "Finished";
        
        return <RB.Card className="mb-2 mt-2" border={ownerActive ? "warning" : finished ? "success" : undefined}>
            <RB.Card.Header>Vote</RB.Card.Header>
            <RB.Card.Body>
                {story && <>
                    <RB.Card.Title>
                        <a href={story.story.story_url || "#"} target="_blank">
                            {story.story.story_url}
                        </a>
                    </RB.Card.Title>
                    <RB.Card.Text>{story.story.story_description}</RB.Card.Text>
                </>}
                
                <RB.Row>
                    {
                        state.vote_options.map((c, i) =>
                            <RB.Col sm={2} className={"p-0 mb-2"} key={i}>
                                <VoteOption state={state} vote={{Value: c}}/>
                            </RB.Col>
                        )
                    }

                    <RB.Col sm={2} className={"p-0 mb-2"}>
                        <VoteOption state={state} vote={"Coffee"}/>
                    </RB.Col>

                    <RB.Col sm={2} className={"p-0 mb-2"}>
                        <VoteOption state={state} vote={"Question"}/>
                    </RB.Col>
                </RB.Row>
            </RB.Card.Body>
        </RB.Card>;
    }
}

@observer
class Person extends React.Component<{state: State, user: UserUpdateMessage}> {
    render() {
        let state = this.props.state;
        let story = state.activeStory;
        let vote = story?.votes[this.props.user.pub_user_uuid];
        let isMe = state.pubUserUuid == this.props.user.pub_user_uuid;
        let disabled = !this.props.user.is_active;
        return <tr>
            <td className="text-break">
                <span className={isMe ? "text-primary" : disabled ? "text-muted" : undefined}>{this.props.user.user_name}</span>
            </td>
            <td>
            {vote &&
                <span className="fw-bold">
                    {renderVote(vote)}
                </span>
            }
            </td>
        </tr>
    }
}

@observer
class Voters extends React.Component<{state: State}> {
    onFinalVoteChange = (ev: React.ChangeEvent<HTMLSelectElement>) => {
        this.props.state.setFinalVoteText(ev.target.value);
    }

    render() {
        let state = this.props.state;
        let mean = state.mean;

        let activeStory = state.activeStory;
        let isOwner = state.owner == state.pubUserUuid;
        let canFinishVoting = isOwner && activeStory && (activeStory.state == "Voting" || activeStory.state == "Flipped");
        let canFlip = isOwner && state.anyHiddenVote;

        return <RB.Card className="mb-2 mt-2">
            <RB.Card.Header>Voters</RB.Card.Header>
            <RB.Card.Body>
                <RB.Table>
                    <tbody>
                        {state.users.filter(u => u.role == "Voter").map(u => <Person key={u.pub_user_uuid} state={state} user={u}/>)}
                    </tbody>
                </RB.Table>

                {mean != null &&
                    <p>
                        <span>Mean: <RB.Badge bg="info" text="dark">{mean}</RB.Badge></span>
                    </p>
                }
                {canFlip &&
                    <p>
                        <RB.Button variant="outline-secondary" size="sm" onClick={() => state.forceFlip()}>Force flip</RB.Button>
                    </p>
                }
                {canFinishVoting &&
                    <RB.InputGroup className="mb-3">
                        <RB.Form.Select aria-label="Default select example" value={state.finalVoteText} onChange={this.onFinalVoteChange}>
                            <option disabled={true} value="">Final vote</option>
                            {state.vote_options.map((c, i) => <option key={c} value={c}>{c}</option>)}
                        </RB.Form.Select>
                        <RB.Button disabled={!state.finalVoteText} size="sm" onClick={() => state.finishVoting()}>Finish</RB.Button>
                    </RB.InputGroup>                    
                }
                {activeStory && activeStory.state == "Finished" &&
                    <p>Final vote: <RB.Badge bg="success">{activeStory.final_vote}</RB.Badge></p>
                }
            </RB.Card.Body>
        </RB.Card>;
    }
}

@observer
class Watchers extends React.Component<{state: State}> {
    render() {
        let state = this.props.state;
        let watchers = state.users.filter(u => u.role == "Watcher");
        if (!watchers.length)
            return null;

        return <RB.Card className="mb-2">
            <RB.Card.Header>Watchers</RB.Card.Header>
            <RB.Card.Body>
                <RB.Table>
                    <tbody>
                        {watchers.map(u => <Person key={u.pub_user_uuid} state={state} user={u}/>)}
                    </tbody>
                </RB.Table>
            </RB.Card.Body>
        </RB.Card>;
    }
}

@observer
class Info extends React.Component<{state: State}> {
    render() {
        let state = this.props.state;
        return <RB.Card className="mb-2">
            <RB.Card.Header>Info</RB.Card.Header>
            <RB.Card.Body>
                <RB.Card.Text>Room: {state.roomCreationTime}</RB.Card.Text>
                <RB.Card.Text>Name: {state.userName}</RB.Card.Text>
                <RB.Card.Text>Role: {state.role}</RB.Card.Text>
                <RB.Button onClick={state.enterUserNameAndRoleDialog} size="sm" variant="link">Change</RB.Button>
            </RB.Card.Body>
        </RB.Card>;
    }
}

@observer
class StoryItemComponent extends React.Component<{state: State, i: number}> {
    deleteStory = () => {
        if (confirm("Delete story?")) {
            this.props.state.deleteStory();
        }
    }
    render() {
        let state = this.props.state;
        let story = state.stories[this.props.i];
        let ownerActive = state.ownerActiveStory == story.story_uuid;
        let myActive = state.myActiveStory == story.story_uuid;
        let isOwner = state.owner == state.pubUserUuid;
        let finished = story.state == "Finished";
        let canSetActive = !finished && myActive && isOwner && story.story_uuid != state.ownerActiveStory;
        let canDelete = myActive && isOwner;
    
        return <RB.ListGroup.Item variant={finished ? "success" : ownerActive ? "warning" : myActive ? "secondary" : ""}
            role="button"
            onClick={() => state.selectMyActiveStory(story.story_uuid)}>
            <b>{this.props.i + 1}</b>
            {' '}
            <a href={story.story.story_url || "#"} target="_blank">
                {story.story.story_url}
            </a>
            {' '}
            {story.story.story_description || ''}
            {' '}
            {finished && story.final_vote != null && <RB.Badge bg="success">{story.final_vote}</RB.Badge>}

            {canSetActive &&<RB.Button size="sm" onClick={() => state.setActive()}>Make active</RB.Button>}
            {canDelete &&<RB.Button size="sm" variant="outline-secondary" className="mx-1" onClick={this.deleteStory}>Delete</RB.Button>}
        </RB.ListGroup.Item>
    }
}

@observer
class Stories extends React.Component<{state: State}> {
    render() {
        let state = this.props.state;
        let isOwner = state.owner == state.pubUserUuid;

        return <RB.Card className="mt-2">
            <RB.Card.Header>Stories</RB.Card.Header>
            <RB.Card.Body>
                <RB.ListGroup variant="flush">
                    {
                        state.stories.map((s, i) => <StoryItemComponent state={state} i={i} key={i}/>)
                    }
                </RB.ListGroup>
            </RB.Card.Body>

            <RB.Button variant={isOwner ? "primary" : "outline-secondary"} onClick={state.openAddStoriesDialog}>Add stories</RB.Button>
            <AddStoriesDialog state={state}/>
        </RB.Card>;
    }
}

@observer
class Form extends React.Component<{state: State}> {
    render() {
        let state = this.props.state;
        if (state.userNameInput) {
            return <EnterUserNameDialog state={state}/>
        }

        return <RB.Container>
            <RB.Row>
                <RB.Col md={8}>
                    {state.role == "Voter" &&
                        <VoteCards state={state}/>
                    }
                    <Stories state={state}/>
                </RB.Col>
                <RB.Col md={4}>
                    <Voters state={state}/>
                    <Watchers state={state}/>
                    <Info state={state}/>
                </RB.Col>
            </RB.Row>
        </RB.Container>
    }
}

function activate() {
    let state = new State();
    ReactDOM.render(
        <Form state={state}/>,
        document.getElementById("react-container")
    );
}

activate();
